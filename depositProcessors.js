// backend/depositProcessors.js
const axios = require("axios");

// Define conversion factors (modify as needed)
const CREDIT_CONVERSION = {
  KAS: 1, // 1 credit = 1 KAS
  // For KRC20, assume that 1 credit equals the amount set by host,
  // so the conversion factor is effectively 1 (the raffle host decides how many tokens = 1 entry)
  KRC20: 1,
};

/**
 * Process KRC20 deposits for a raffle.
 * This will query the Kasplex API for token transfers to the raffle wallet,
 * using the raffle's dynamically set tokenTicker.
 */
async function processRaffleTokenDeposits(raffle) {
  if (!Array.isArray(raffle.processedTransactions)) {
    raffle.processedTransactions = [];
  }
  
  const walletAddress = raffle.wallet.receivingAddress;
  const ticker = raffle.tokenTicker.trim().toUpperCase();
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
      // Convert sompi (1e8) into token units
      const amount = parseInt(tx.amt, 10) / 1e8;
      const opType = tx.op.toLowerCase();
      const toAddress = tx.to;
      
      // Skip if already processed
      const alreadyProcessed = raffle.processedTransactions.some(
        (t) => t.txid === txid
      );
      
      // Process only "transfer" operations to this wallet that haven't been processed
      if (opType === "transfer" && toAddress === walletAddress && !alreadyProcessed) {
        // Here, the raffle.host defines the credit conversion.
        // For example, if raffle.creditConversion is 1000, then 1000 tokens = 1 entry.
        const creditsToAdd = amount / parseFloat(raffle.creditConversion);
        raffle.currentEntries = (raffle.currentEntries || 0) + creditsToAdd;
        raffle.totalEntries = (raffle.totalEntries || 0) + creditsToAdd;
        
        raffle.processedTransactions.push({
          txid,
          coinType: ticker,
          amount,
          creditsAdded: creditsToAdd,
          timestamp: new Date()
        });
        console.log(
          `Credited ${creditsToAdd.toFixed(8)} entries to raffle ${raffle.raffleId} from ${ticker} tx ${txid}`
        );
      }
    }
  } catch (err) {
    console.error(`Error fetching ${ticker} deposits for ${walletAddress}:`, err.message);
  }
}

/**
 * Process KAS deposits for a raffle.
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
          const creditsToAdd = sumToWallet / 1; // 1 credit per KAS
          raffle.currentEntries = (raffle.currentEntries || 0) + creditsToAdd;
          raffle.totalEntries = (raffle.totalEntries || 0) + creditsToAdd;
          
          raffle.processedTransactions.push({
            txid: txHash,
            coinType: "KAS",
            amount: sumToWallet,
            creditsAdded: creditsToAdd,
            timestamp: new Date()
          });
          console.log(
            `Credited ${creditsToAdd.toFixed(8)} entries to raffle ${raffle.raffleId} from KAS tx ${txHash}`
          );
        }
      }
    }
  } catch (err) {
    console.error(`Error fetching KAS for ${walletAddress}:`, err.message);
  }
}

module.exports = {
  processRaffleTokenDeposits,
  processRaffleKaspaDeposits
};
