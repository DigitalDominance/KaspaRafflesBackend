const cron = require('node-cron');
const axios = require('axios');
const Raffle = require('./models/Raffle');
const { sendKaspa, sendKRC20 } = require('./wasm_rpc');

// Helper function to pause execution (wait n milliseconds)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Find raffles that are either still "live" (and expired) OR are completed but prizeDispersed is still false.
    const rafflesToProcess = await Raffle.find({
      $or: [
        { status: "live", timeFrame: { $lte: now } },
        { status: "completed", prizeDispersed: false }
      ]
    });
    console.log(`Found ${rafflesToProcess.length} raffles to process.`);

    for (const raffle of rafflesToProcess) {
      // ----- PART 1: Winner selection and prize dispersal (existing logic) -----
      if (raffle.status === "live") {
        if (raffle.entries && raffle.entries.length > 0) {
          const walletTotals = {};
          raffle.entries.forEach(entry => {
            walletTotals[entry.walletAddress] = (walletTotals[entry.walletAddress] || 0) + entry.creditsAdded;
          });
          if (raffle.winnersCount === 1) {
            const totalCredits = Object.values(walletTotals).reduce((sum, val) => sum + val, 0);
            let random = Math.random() * totalCredits;
            let chosen = null;
            for (const [wallet, credits] of Object.entries(walletTotals)) {
              random -= credits;
              if (random <= 0) {
                chosen = wallet;
                break;
              }
            }
            raffle.winner = chosen;
            raffle.winnersList = [];
          } else {
            const winners = [];
            const availableWallets = { ...walletTotals };
            const maxWinners = Math.min(raffle.winnersCount, Object.keys(availableWallets).length);
            for (let i = 0; i < maxWinners; i++) {
              const totalCredits = Object.values(availableWallets).reduce((sum, val) => sum + val, 0);
              let random = Math.random() * totalCredits;
              let chosenWallet = null;
              for (const [wallet, credits] of Object.entries(availableWallets)) {
                random -= credits;
                if (random <= 0) {
                  chosenWallet = wallet;
                  break;
                }
              }
              if (chosenWallet) {
                winners.push(chosenWallet);
                delete availableWallets[chosenWallet];
              }
            }
            raffle.winner = winners.length === 1 ? winners[0] : null;
            raffle.winnersList = winners;
          }
          raffle.status = "completed";
          raffle.completedAt = now;
          await raffle.save();
        } else {
          raffle.winner = "No Entries";
          raffle.winnersList = [];
          raffle.status = "completed";
          raffle.completedAt = now;
          await raffle.save();
        }
      }

      // Prize dispersal for winners.
      let winnersArray = [];
      if (raffle.winnersList && raffle.winnersList.length > 0) {
        winnersArray = raffle.winnersList;
      } else if (raffle.winner && raffle.winner !== "No Entries") {
        winnersArray = [raffle.winner];
      }
      if (winnersArray.length > 0) {
        const totalPrize = raffle.prizeAmount;
        const perWinnerPrize = totalPrize / winnersArray.length;
        let allTxSuccess = true;
        const alreadyProcessed = raffle.prizeDispersalTxids.map(tx => tx.winnerAddress);
        for (const winnerAddress of winnersArray) {
          if (alreadyProcessed.includes(winnerAddress)) {
            console.log(`Prize already sent to ${winnerAddress}, skipping.`);
            continue;
          }
          try {
            let txid;
            if (raffle.prizeType === "KAS") {
              txid = await sendKaspa(winnerAddress, perWinnerPrize);
            } else if (raffle.prizeType === "KRC20") {
              // Use the stored prize ticker
              txid = await sendKRC20(winnerAddress, perWinnerPrize, raffle.prizeTicker);
            }
            console.log(`Sent prize to ${winnerAddress}. Transaction ID: ${txid}`);
            raffle.processedTransactions.push({
              txid,
              coinType: raffle.prizeType,
              amount: perWinnerPrize,
              winnerAddress,
              timestamp: new Date()
            });
            raffle.prizeDispersalTxids.push({ winnerAddress, txid, timestamp: new Date() });
            await sleep(10000); // wait 10 seconds between transactions
          } catch (err) {
            console.error(`Error sending prize to ${winnerAddress}: ${err.message}`);
            allTxSuccess = false;
          }
        }
        const allProcessed = winnersArray.every(
          winnerAddress => raffle.prizeDispersalTxids.some(tx => tx.winnerAddress === winnerAddress)
        );
        if (allProcessed && allTxSuccess) {
          raffle.prizeConfirmed = true;
          raffle.prizeDispersed = true;
        } else {
          raffle.prizeDispersed = false;
        }
        await raffle.save();
        if (allProcessed && allTxSuccess) {
          console.log(`Raffle ${raffle.raffleId} completed. All prizes dispersed successfully.`);
        } else {
          console.log(`Raffle ${raffle.raffleId} completed. Some prize transactions failed; successful ones will not be resent.`);
        }
      } else {
        console.log(`Raffle ${raffle.raffleId} completed. No valid entries for prize distribution.`);
      }

      // Helper function to remove the "xprv" prefix from a key.
function formatXPrv(xprv) {
  if (typeof xprv === 'string' && xprv.startsWith('xprv')) {
    return xprv.slice(4);
  }
  return xprv;
}

      // ----- PART 2: Generated Tokens Dispersal -----
      if (!raffle.generatedTokensDispersed) {
        // Calculate generated tokens from DB:
        // (Assuming generatedTokens = totalEntries * creditConversion)
        const generatedTokens = raffle.totalEntries * raffle.creditConversion;
      
        if (raffle.type === 'KRC20') {
          // --- Top-up: Ensure raffle wallet has at least 15 KAS ---
          let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          if (kasBalanceKAS < 15) {
            const needed = 15 - kasBalanceKAS;
            // Top-up is sent using treasury wallet's private key
            const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
            console.log(`Sent extra ${needed} KAS to raffle wallet for gas: ${txidExtra}`);
            await sleep(10000);
          }
          // --- Token Dispersion: ---
          if (generatedTokens > 0) {
            const feeTokens = Math.floor(generatedTokens * 0.05);
            const creatorTokens = generatedTokens - feeTokens;
            const raffleKey = formatXPrv(raffle.wallet.xPrv);
            // Send fee (5%) from raffle wallet to treasury using raffle wallet's private key.
            const txidFee = await sendKRC20(raffle.treasuryAddress, feeTokens, raffle.tokenTicker, raffleKey);
            console.log(`Sent fee (5%) from raffle wallet to treasury: ${txidFee}`);
            await sleep(10000);
            // Send remainder (95%) from raffle wallet to creator.
            const txidCreator = await sendKRC20(raffle.creator, creatorTokens, raffle.tokenTicker, raffleKey);
            console.log(`Sent tokens (95%) from raffle wallet to creator: ${txidCreator}`);
            await sleep(10000);
          }
          // --- Return Remaining KAS: ---
          kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          const remainingKAS = kasBalanceKAS > 15 ? kasBalanceKAS - 15 : 0;
          if (remainingKAS > 0) {
            // Returning remaining KAS uses the raffle wallet's key.
            const raffleKey = formatXPrv(raffle.wallet.xPrv);
            const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
            console.log(`Sent remaining KAS from raffle wallet to treasury: ${txidRemaining}`);
            await sleep(10000);
          }
        } else if (raffle.type === 'KAS') {
          // --- Top-up: Ensure raffle wallet has at least 3 KAS ---
          let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          if (kasBalanceKAS < 3) {
            const needed = 3 - kasBalanceKAS;
            // Top-up is sent using treasury wallet's key.
            const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
            console.log(`Sent extra ${needed} KAS to raffle wallet for gas (KAS raffle): ${txidExtra}`);
            await sleep(10000);
          }
          // --- Return Remaining KAS: ---
          kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          const remainingKAS = kasBalanceKAS > 3 ? kasBalanceKAS - 3 : 0;
          if (remainingKAS > 0) {
            const raffleKey = formatXPrv(raffle.wallet.xPrv);
            const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
            console.log(`Sent remaining KAS from raffle wallet to treasury (KAS raffle): ${txidRemaining}`);
            await sleep(10000);
          }
        }
        raffle.generatedTokensDispersed = true;
        await raffle.save();
        console.log(`Generated tokens dispersed for raffle ${raffle.raffleId}`);
      }

    }
  } catch (err) {
    console.error('Error in completing raffles:', err);
  }
}

// Schedule the job to run every minute.
cron.schedule('* * * * *', async () => {
  console.log('Running raffle completion scheduler...');
  await completeExpiredRaffles();
});

console.log('Raffle completion scheduler started.');
