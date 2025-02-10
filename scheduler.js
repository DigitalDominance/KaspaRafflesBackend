const cron = require('node-cron');
const Raffle = require('./models/Raffle');
const { sendKaspa, sendKRC20 } = require('./wasm_rpc');

async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Find raffles that are either still "live" and expired OR are completed but prizeDispersed is still false.
    const rafflesToProcess = await Raffle.find({
      $or: [
        { status: "live", timeFrame: { $lte: now } },
        { status: "completed", prizeDispersed: false }
      ]
    });
    console.log(`Found ${rafflesToProcess.length} raffles to process.`);

    for (const raffle of rafflesToProcess) {
      // If raffle is still live, perform winner selection.
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

      // At this point the raffle status is "completed". Attempt prize dispersal if winners exist.
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
        let allTxSuccess = true; // Track if all prize transactions succeed

        // Inside your scheduler's prize dispersal loop:
        for (const winnerAddress of winnersArray) {
          try {
            let txid;
            if (raffle.prizeType === "KAS") {
              txid = await sendKaspa(winnerAddress, perWinnerPrize);
            } else if (raffle.prizeType === "KRC20") {
              // Use raffle.prizeTicker now (instead of raffle.tokenTicker)
              txid = await sendKRC20(winnerAddress, perWinnerPrize, raffle.prizeTicker);
            }
            console.log(`Sent prize to ${winnerAddress}. Transaction ID: ${txid}`);
            raffle.processedTransactions.push({
              txid,
              coinType: raffle.prizeType,
              amount: perWinnerPrize,
              timestamp: new Date()
            });
          } catch (err) {
            console.error(`Error sending prize to ${winnerAddress}: ${err.message}`);
            allTxSuccess = false;
          }
        }

        if (allTxSuccess) {
          raffle.prizeConfirmed = true;
          raffle.prizeDispersed = true;
        } else {
          raffle.prizeDispersed = false;
        }
        await raffle.save();

        if (allTxSuccess) {
          console.log(`Raffle ${raffle.raffleId} completed. Winners: ${winnersArray.join(', ')}. Prizes dispersed successfully.`);
        } else {
          console.log(`Raffle ${raffle.raffleId} completed. Winners: ${winnersArray.join(', ')}. Prize dispersal incomplete. Will reattempt on next scheduler run.`);
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
