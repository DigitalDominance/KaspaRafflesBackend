const axios = require("axios");

// In this example the conversion factors are one-to-one.
const CREDIT_CONVERSION = {
  KRC20: 1,
  KAS: 1,
};

/**
 * Process KRC20 token deposits for a raffle.
 *
 * @param {Object} raffle - A raffle document from MongoDB.
 */
async function processRaffleTokenDeposits(raffle) {
  if (!Array.isArray(raffle.processedTransactions)) {
    raffle.processedTransactions = [];
  }
  
  const walletAddress = raffle.wallet.receivingAddress;
  const ticker = raffle.tokenTicker;
  const url = `https://api.kasplex.org/v1/krc20/oplist?address=${walletAddress}&tick=${ticker}`;
  
  try {
    const response = await axios.get(url);
    if (response.data.message !== "successful") {
      console.error(`Unexpected response for ${ticker} at ${walletAddress}:`, response.data);
      return;
    }
    
    const transactions = response.data.result || [];
    
    for (const tx of transactions) {
      const txid = tx.hashRev;
      // Convert sompi (1e8) into token units.
      const amount = parseInt(tx.amt, 10) / 1e8;
      const opType = tx.op;
      const toAddress = tx.to;
      
      // Skip if already processed
      const alreadyProcessed = raffle.processedTransactions.some(
        (t) => t.txid === txid
      );
      
      if (
        opType.toLowerCase() === "transfer" &&
        toAddress === walletAddress &&
        !alreadyProcessed
      ) {
        // Only credit if deposit meets the minimum (creditConversion).
        if (amount >= raffle.creditConversion / 1e8) {
          const entriesToAdd = amount * CREDIT_CONVERSION.KRC20;
          raffle.currentEntries = (raffle.currentEntries || 0) + entriesToAdd;
          raffle.totalEntries = (raffle.totalEntries || 0) + entriesToAdd;
        }
        
        raffle.processedTransactions.push({
          txid,
          coinType: ticker,
          amount,
          timestamp: new Date()
        });
        
        console.log(
          `Processed ${ticker} deposit of ${amount} to raffle ${raffle.raffleId} from tx ${txid}`
        );
      }
    }
  } catch (err) {
    console.error(`Error fetching ${ticker} deposits for wallet ${walletAddress}:`, err.message);
  }
}

/**
 * Process KAS deposits for a raffle.
 *
 * @param {Object} raffle - A raffle document from MongoDB.
 */
async function processRaffleKaspaDeposits(raffle) {
  if (!Array.isArray(raffle.processedTransactions)) {
    raffle.processedTransactions = [];
  }
  
  const walletAddress = raffle.wallet.receivingAddress;
  const url = `https://api.kaspa.org/addresses/${walletAddress}/full-transactions?limit=50&offset=0&resolve_previous_outpoints=no`;
  
  try {
    const response = await axios.get(url);
    const transactions = Array.isArray(response.data) ? response.data : [];
    
    for (const tx of transactions) {
      const txHash = tx.hash;
      if (!tx.outputs || tx.outputs.length === 0) continue;
      
      let sumToWallet = 0;
      for (const output of tx.outputs) {
        if (output.script_public_key_address === walletAddress) {
          const outKas = parseInt(output.amount, 10) / 1e8;
          sumToWallet += outKas;
        }
      }
      
      if (sumToWallet > 0) {
        const alreadyProcessed = raffle.processedTransactions.some(
          (t) => t.txid === txHash
        );
        if (!alreadyProcessed) {
          if (sumToWallet >= raffle.creditConversion / 1e8) {
            const entriesToAdd = sumToWallet * CREDIT_CONVERSION.KAS;
            raffle.currentEntries = (raffle.currentEntries || 0) + entriesToAdd;
            raffle.totalEntries = (raffle.totalEntries || 0) + entriesToAdd;
          }
          
          raffle.processedTransactions.push({
            txid: txHash,
            coinType: "KAS",
            amount: sumToWallet,
            timestamp: new Date()
          });
          
          console.log(
            `Processed KAS deposit of ${sumToWallet} to raffle ${raffle.raffleId} from tx ${txHash}`
          );
        }
      }
    }
  } catch (err) {
    console.error(`Error fetching KAS deposits for wallet ${walletAddress}:`, err.message);
  }
}

module.exports = {
  processRaffleTokenDeposits,
  processRaffleKaspaDeposits
};
