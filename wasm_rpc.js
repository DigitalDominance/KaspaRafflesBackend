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

// Initialize RPC client with the integrated public URLs (for wallet creation and other default operations)
const rpc = new RpcClient({
  resolver: new Resolver(),
  networkId: "mainnet",
});

// Treasury wallet credentials from environment variables
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

// -----------------------------------------------------------------
// Utility function to create a wallet (DO NOT REMOVE THIS COMMAND)
// -----------------------------------------------------------------
async function createWallet() {
  try {
    // Generate a new mnemonic
    const mnemonic = Mnemonic.random();
    const seed = mnemonic.toSeed();
    const xPrv = new XPrv(seed);

    // Derive receiving address
    const receivePath = "m/44'/111111'/0'/0/0";
    const receiveKey = xPrv.derivePath(receivePath).toXPub().toPublicKey();
    const receiveAddress = receiveKey.toAddress(NetworkType.Mainnet);

    // Derive change address
    const changePath = "m/44'/111111'/0'/1/0";
    const changeKey = xPrv.derivePath(changePath).toXPub().toPublicKey();
    const changeAddress = changeKey.toAddress(NetworkType.Mainnet);

    // Return wallet data
    return {
      success: true,
      mnemonic: mnemonic.phrase,
      receivingAddress: receiveAddress.toString(),
      changeAddress: changeAddress.toString(),
      xPrv: xPrv.intoString("xprv"),
    };
  } catch (err) {
    // Return error as a JSON response
    return { success: false, error: err.message };
  }
}

// -----------------------------------------------------------------
// NEW: Function to send KAS (Kaspa) Prize using a UTXO based TransactionSender
// -----------------------------------------------------------------
/**
 * Send Kaspa prize from the treasury wallet to a destination address.
 * @param {string} destination - The recipient Kaspa address.
 * @param {string|number} amount - The amount in KAS to send.
 * @returns {Promise<string>} - The transaction id.
 */
async function sendKaspa(destination, amount) {
  const networkId = process.env.NETWORK_ID || "mainnet";
  const RPC = new RpcClient({
    resolver: new Resolver(),
    networkId,
    encoding: Encoding.Borsh,
  });
  await RPC.connect();

  // Create a PrivateKey instance for the treasury wallet.
  const treasuryPrivKey = new PrivateKey(TREASURY_PRIVATE_KEY);

  // Internal class for sending a transaction
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

      // Process transactions sequentially.
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
    const transactionSender = new TransactionSender(networkId, treasuryPrivKey, RPC);
    // Allow the processor to start.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const txid = await transactionSender.transferFunds(destination, amount);
    await new Promise(resolve => setTimeout(resolve, 5000));
    await RPC.disconnect();
    return txid;
  } catch (err) {
    await RPC.disconnect();
    throw new Error("Error sending KAS: " + err.message);
  }
}

/**
 * Send KRC20 token prize from the treasury wallet to a destination address.
 * This function mirrors the KAS sending logic (using default fees and timeouts)
 * while performing the commit and reveal phases.
 *
 * @param {string} destination - The recipient address.
 * @param {string|number} amount - The token amount to send (in token units, e.g. 100).
 * @param {string} ticker - The KRC20 token ticker.
 * @returns {Promise<string>} - The final transaction id (the reveal hash).
 */
async function sendKRC20(destination, amount, ticker) {
  // Use default constants (these mimic the KAS flow)
  const network = process.env.NETWORK_ID || "mainnet";
  const DEFAULT_PRIORITY_FEE = "0.02"; // same as used in sendKaspa
  const DEFAULT_GAS_FEE = "0.01";
  const DEFAULT_TIMEOUT = 120000; // 2 minutes

  // Create an RPC client with Borsh encoding.
  const RPC = new RpcClient({
    resolver: new Resolver(),
    encoding: Encoding.Borsh,
    networkId: network
  });
  await RPC.connect();

  // Treasury private key and its public key.
  const treasuryPrivKey = new PrivateKey(TREASURY_PRIVATE_KEY);
  const publicKey = treasuryPrivKey.toPublicKey();

  // *** IMPORTANT CONVERSION STEP ***
  // Convert the token amount using the kaspaToSompi conversion.
  // For example, if you pass in 100, this will convert it to 100 × 1e8.
  const convertedAmount = kaspaToSompi(amount.toString());
  
  // Prepare the KRC20 transfer data using the converted amount.
  const data = {
    "p": "krc-20",
    "op": "transfer",
    "tick": ticker,
    // Use the converted amount here
    "amt": convertedAmount.toString(),
    "to": destination
  };

  // Build the spending script.
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

  // Subscribe to UTXO changes for the treasury wallet address.
  await RPC.subscribeUtxosChanged([publicKey.toAddress(network).toString()]);
  let eventReceived = false;
  let submittedTrxId;

  // Listen for UTXO changes to determine when the commit/reveal transactions mature.
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
    // -------------------------
    // Commit Phase
    // -------------------------
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
      tx.sign([treasuryPrivKey]);
      submittedTrxId = await tx.submit(RPC);
    }

    // Wait for the commit phase to mature.
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

    // -------------------------
    // Reveal Phase
    // -------------------------
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
      tx.sign([treasuryPrivKey], false);
      const inputIndex = tx.transaction.inputs.findIndex(input => input.signatureScript === "");
      if (inputIndex !== -1) {
        const signature = await tx.createInputSignature(inputIndex, treasuryPrivKey);
        tx.fillInput(inputIndex, script.encodePayToScriptHashSignatureScript(signature));
      }
      revealHash = await tx.submit(RPC);
      submittedTrxId = revealHash;
    }

    // Wait for the reveal phase to mature.
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
    throw new Error("Error sending KRC20: " + err.message);
  }
}


// -----------------------------------------------------------------
// Command-line interface for testing (keeps createWallet command intact)
// -----------------------------------------------------------------
if (require.main === module) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      // Usage examples:
      // node wasm_rpc.js sendKaspa <destination> <amount>
      // node wasm_rpc.js sendKRC20 <destination> <amount> <ticker>
      if (args[0] === "sendKaspa") {
        const [, destination, amount] = args;
        const txid = await sendKaspa(destination, amount);
        console.log("KAS Transaction ID:", txid);
      } else if (args[0] === "sendKRC20") {
        const [, destination, amount, ticker] = args;
        const txid = await sendKRC20(destination, amount, ticker);
        console.log("KRC20 Transaction ID:", txid);
      } else {
        // Default to creating a new wallet.
        const result = await createWallet();
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(JSON.stringify({ success: false, error: err.message }));
    }
  })();
}

module.exports = { createWallet, sendKaspa, sendKRC20 };
