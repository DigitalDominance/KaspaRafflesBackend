const cron = require('node-cron');
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
      // If the raffle is still live, perform winner selection.
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
                // Remove this wallet so it can't win again.
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

      // At this point the raffle status is "completed".
      // Determine the list of winners for prize dispersal.
      let winnersArray = [];
      if (raffle.winnersList && raffle.winnersList.length > 0) {
        winnersArray = raffle.winnersList;
      } else if (raffle.winner && raffle.winner !== "No Entries") {
        winnersArray = [raffle.winner];
      }

      // Only send prizes if winners exist.
      if (winnersArray.length > 0) {
        const totalPrize = raffle.prizeAmount;
        const perWinnerPrize = totalPrize / winnersArray.length;
        let allTxSuccess = true; // Flag to track overall success

        // Determine which winners have already been processed.
        // We assume each processed transaction record now includes a `winnerAddress` field.
        const alreadyProcessed = raffle.prizeDispersalTxids.map(tx => tx.winnerAddress);

        // Process each winner that hasn't already been sent a prize.
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
              // Use the stored prize ticker (saved as prizeTicker on creation)
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
            // Save the prize dispersal TXID in the new field.
            raffle.prizeDispersalTxids.push({ winnerAddress, txid, timestamp: new Date() });
            // Wait 10 seconds between sending prizes to each winner.
            await sleep(10000);
          } catch (err) {
            console.error(`Error sending prize to ${winnerAddress}: ${err.message}`);
            allTxSuccess = false;
          }
        }

        // Check if every winner has now been processed.
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
