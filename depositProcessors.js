// backend/depositProcessors.js
const axios = require("axios");

/**
 * Helper: Update the entries array for a given raffle.
 * If an entry for walletAddress exists, add credits; otherwise, push a new entry.
 */
function updateEntries(raffle, walletAddress, creditsToAdd, amount) {
  const existingEntry = raffle.entries.find(e => e.walletAddress === walletAddress);
  if (existingEntry) {
    existingEntry.creditsAdded += creditsToAdd;
    // Optionally update amount if you want to store cumulative amount:
    existingEntry.amount += amount;
    existingEntry.confirmedAt = new Date();
  } else {
    raffle.entries.push({
      walletAddress,
      creditsAdded: creditsToAdd,
      amount,
      confirmedAt: new Date()
    });
  }
}

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
      const amount = parseInt(tx.amt, 10) / 1e8; // token units
      const opType = tx.op.toLowerCase();
      const toAddress = tx.to;
      
      // Skip if already processed
      const alreadyProcessed = raffle.processedTransactions.some(
        (t) => t.txid === txid
      );
      
      if (opType === "transfer" && toAddress === walletAddress && !alreadyProcessed) {
        // Calculate credits dynamically: credits = amount / creditConversion.
        const creditsToAdd = amount / parseFloat(raffle.creditConversion);
        raffle.currentEntries += creditsToAdd;
        raffle.totalEntries += creditsToAdd;
        
        // Update or add in entries array (using walletAddress as key)
        updateEntries(raffle, toAddress, creditsToAdd, amount);
        
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
          sumToWallet += parseInt(output.amount, 10) / 1e8;
        }
      }
      
      if (sumToWallet > 0) {
        const alreadyProcessed = raffle.processedTransactions.some(
          (t) => t.txid === txHash
        );
        if (!alreadyProcessed) {
          const creditsToAdd = sumToWallet / parseFloat(raffle.creditConversion);
          raffle.currentEntries += creditsToAdd;
          raffle.totalEntries += creditsToAdd;
          
          updateEntries(raffle, walletAddress, creditsToAdd, sumToWallet);
          
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
