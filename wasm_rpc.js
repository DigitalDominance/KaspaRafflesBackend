// backend/wasm_rpc.js

// Global WebSocket shim for environments without native WebSocket support
globalThis.WebSocket = require("websocket").w3cwebsocket;

const kaspa = require("./wasm/kaspa");
const {
  Mnemonic,
  XPrv,
  NetworkType,
  initConsolePanicHook,
  RpcClient,
  Resolver,
  // Additional imports for sending transactions:
  Encoding,
  ScriptBuilder,
  Opcodes,
  PrivateKey,
  addressFromScriptPublicKey,
  createTransactions,
  kaspaToSompi,
  UtxoProcessor,
  UtxoContext,
} = kaspa;

// Enable console panic hooks for debugging
initConsolePanicHook();

// Initialize RPC client (for wallet creation, etc.)
const rpc = new RpcClient({
  resolver: new Resolver(),
  networkId: "mainnet",
});

// Treasury wallet credentials from environment variables
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

/**
 * Helper function to remove the "xprv" prefix.
 * (We now store a separate transactionPrivateKey so this is used only in fallback cases.)
 */
function formatXPrv(xprv) {
  if (typeof xprv === 'string' && xprv.startsWith('xprv')) {
    return xprv.slice(4);
  }
  return xprv;
}

// -----------------------------------------------------------------
// Utility function to create a wallet (DO NOT REMOVE THIS COMMAND)
// -----------------------------------------------------------------
async function createWallet() {
  try {
    const mnemonic = Mnemonic.random();
    const seed = mnemonic.toSeed();
    const xPrv = new XPrv(seed);
    // For display, derive receiving address from first receiving path:
    const receivePathDisplay = "m/44'/111111'/0'/0/0";
    const receiveKey = xPrv.derivePath(receivePathDisplay).toXPub().toPublicKey();
    const receivingAddress = receiveKey.toAddress(NetworkType.Mainnet);
    // For transactions, derive a private key from a different path (as in your demo):
    const transactionPath = "m/44'/111111'/0'/0/1";
    const transactionPrivateKey = xPrv.derivePath(transactionPath).toPrivateKey();
    // Derive change address:
    const changePath = "m/44'/111111'/0'/1/0";
    const changeKey = xPrv.derivePath(changePath).toXPub().toPublicKey();
    const changeAddress = changeKey.toAddress(NetworkType.Mainnet);
    return {
      success: true,
      mnemonic: mnemonic.phrase,
      receivingAddress: receivingAddress.toString(),
      changeAddress: changeAddress.toString(),
      xPrv: xPrv.intoString("xprv"),
      // Store the actual private key for transactions as a string.
      transactionPrivateKey: transactionPrivateKey.toString(),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// -----------------------------------------------------------------
// sendKaspa: Now accepts an optional customPrivKey parameter.
// -----------------------------------------------------------------
async function sendKaspa(destination, amount, customPrivKey) {
  const networkId = process.env.NETWORK_ID || "mainnet";
  const RPC = new RpcClient({
    resolver: new Resolver(),
    networkId,
    encoding: Encoding.Borsh,
  });
  await RPC.connect();

  // Use custom key if provided; otherwise, use treasury key.
  const keyToUse = customPrivKey ? new PrivateKey(customPrivKey) : new PrivateKey(TREASURY_PRIVATE_KEY);

  class TransactionSender {
    constructor(networkId, privateKey, rpc) {
      this.networkId = networkId;
      this.privateKey = privateKey;
      this.rpc = rpc;
      this.processor = new UtxoProcessor({ rpc, networkId });
      this.context = new UtxoContext({ processor: this.processor });
      this.registerProcessor();
    }
    async transferFunds(address, amount) {
      const payments = [{
        address,
        amount: kaspaToSompi(amount.toString())
      }];
      return await this.send(payments);
    }
    async send(outputs) {
      const { transactions, summary } = await createTransactions({
        entries: this.context,
        outputs,
        changeAddress: this.privateKey.toPublicKey().toAddress(this.networkId).toString(),
        priorityFee: kaspaToSompi("0.02")
      });
      for (const tx of transactions) {
        tx.sign([this.privateKey]);
        await tx.submit(this.rpc);
      }
      return summary.finalTransactionId;
    }
    registerProcessor() {
      this.processor.addEventListener("utxo-proc-start", async () => {
        await this.context.clear();
        await this.context.trackAddresses([
          this.privateKey.toPublicKey().toAddress(this.networkId).toString()
        ]);
      });
      this.processor.start();
    }
  }

  try {
    const transactionSender = new TransactionSender(networkId, keyToUse, RPC);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const txid = await transactionSender.transferFunds(destination, amount);
    await new Promise(resolve => setTimeout(resolve, 5000));
    await RPC.disconnect();
    return txid;
  } catch (err) {
    await RPC.disconnect();
    throw new Error("Error sending KAS: " + (err.message || JSON.stringify(err)));
  }
}

// -----------------------------------------------------------------
// sendKRC20: Now accepts an optional customPrivKey parameter.
// -----------------------------------------------------------------
async function sendKRC20(destination, amount, ticker, customPrivKey) {
  const network = process.env.NETWORK_ID || "mainnet";
  const DEFAULT_PRIORITY_FEE = "0.02";
  const DEFAULT_GAS_FEE = "0.3";
  const DEFAULT_TIMEOUT = 120000;
  
  const RPC = new RpcClient({
    resolver: new Resolver(),
    encoding: Encoding.Borsh,
    networkId: network
  });
  await RPC.connect();
  
  const keyToUse = customPrivKey ? new PrivateKey(customPrivKey) : new PrivateKey(TREASURY_PRIVATE_KEY);
  const publicKey = keyToUse.toPublicKey();
  
  const convertedAmount = kaspaToSompi(amount.toString());
  const data = {
    "p": "krc-20",
    "op": "transfer",
    "tick": ticker,
    "amt": convertedAmount.toString(),
    "to": destination
  };
  
  const script = new ScriptBuilder()
    .addData(publicKey.toXOnlyPublicKey().toString())
    .addOp(Opcodes.OpCheckSig)
    .addOp(Opcodes.OpFalse)
    .addOp(Opcodes.OpIf)
    .addData(Buffer.from("kasplex"))
    .addI64(0n)
    .addData(Buffer.from(JSON.stringify(data)))
    .addOp(Opcodes.OpEndIf);
  
  const P2SHAddress = addressFromScriptPublicKey(script.createPayToScriptHashScript(), network);
  if (!P2SHAddress) {
    await RPC.disconnect();
    throw new Error("Failed to create P2SH address for KRC20 transfer");
  }
  
  await RPC.subscribeUtxosChanged([publicKey.toAddress(network).toString()]);
  let eventReceived = false;
  let submittedTrxId;
  
  RPC.addEventListener('utxos-changed', async (event) => {
    const addrStr = publicKey.toAddress(network).toString();
    const addedEntry = event.data.added.find(entry =>
      entry.address.payload === addrStr.split(':')[1]
    );
    if (addedEntry && addedEntry.outpoint.transactionId === submittedTrxId) {
      eventReceived = true;
    }
  });
  
  try {
    const { entries } = await RPC.getUtxosByAddresses({ addresses: [publicKey.toAddress(network).toString()] });
    const { transactions } = await createTransactions({
      priorityEntries: [],
      entries,
      outputs: [{
        address: P2SHAddress.toString(),
        amount: kaspaToSompi(DEFAULT_GAS_FEE)
      }],
      changeAddress: publicKey.toAddress(network).toString(),
      priorityFee: kaspaToSompi(DEFAULT_PRIORITY_FEE),
      networkId: network
    });
  
    for (const tx of transactions) {
      tx.sign([keyToUse]);
      submittedTrxId = await tx.submit(RPC);
    }
  
    await new Promise((resolve, reject) => {
      const commitTimeout = setTimeout(() => {
        if (!eventReceived) {
          reject(new Error("Timeout waiting for commit UTXO maturity"));
        }
      }, DEFAULT_TIMEOUT);
      (async function waitForEvent() {
        while (!eventReceived) {
          await new Promise(r => setTimeout(r, 500));
        }
        clearTimeout(commitTimeout);
        resolve();
      })();
    });
  
    const { entries: currentEntries } = await RPC.getUtxosByAddresses({ addresses: [publicKey.toAddress(network).toString()] });
    const revealUTXOs = await RPC.getUtxosByAddresses({ addresses: [P2SHAddress.toString()] });
  
    const { transactions: revealTxs } = await createTransactions({
      priorityEntries: [revealUTXOs.entries[0]],
      entries: currentEntries,
      outputs: [],
      changeAddress: publicKey.toAddress(network).toString(),
      priorityFee: kaspaToSompi(DEFAULT_GAS_FEE),
      networkId: network
    });
  
    let revealHash;
    for (const tx of revealTxs) {
      tx.sign([keyToUse], false);
      const inputIndex = tx.transaction.inputs.findIndex(input => input.signatureScript === "");
      if (inputIndex !== -1) {
        const signature = await tx.createInputSignature(inputIndex, keyToUse);
        tx.fillInput(inputIndex, script.encodePayToScriptHashSignatureScript(signature));
      }
      revealHash = await tx.submit(RPC);
      submittedTrxId = revealHash;
    }
  
    eventReceived = false;
    await new Promise((resolve, reject) => {
      const revealTimeout = setTimeout(() => {
        if (!eventReceived) {
          reject(new Error("Timeout waiting for reveal UTXO maturity"));
        }
      }, DEFAULT_TIMEOUT);
      (async function waitForReveal() {
        while (!eventReceived) {
          await new Promise(r => setTimeout(r, 500));
        }
        clearTimeout(revealTimeout);
        resolve();
      })();
    });
  
    await RPC.disconnect();
    return revealHash;
  } catch (err) {
    await RPC.disconnect();
    throw new Error("Error sending KRC20: " + (err.message || JSON.stringify(err)));
  }
}

if (require.main === module) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      if (args[0] === "sendKaspa") {
        const [, destination, amount] = args;
        const txid = await sendKaspa(destination, amount);
        console.log("KAS Transaction ID:", txid);
      } else if (args[0] === "sendKRC20") {
        const [, destination, amount, ticker] = args;
        const txid = await sendKRC20(destination, amount, ticker);
        console.log("KRC20 Transaction ID:", txid);
      } else {
        const result = await createWallet();
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(JSON.stringify({ success: false, error: err.message }));
    }
  })();
}

module.exports = { createWallet, sendKaspa, sendKRC20 };
