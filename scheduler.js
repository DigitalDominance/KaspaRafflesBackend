const cron = require('node-cron');
const Raffle = require('./models/Raffle');

// Function to complete expired raffles
async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Find all raffles that are still live and have reached (or passed) their end time.
    const expiredRaffles = await Raffle.find({ status: "live", timeFrame: { $lte: now } });
    console.log(`Found ${expiredRaffles.length} expired raffles to complete.`);
    for (const raffle of expiredRaffles) {
      if (raffle.entries && raffle.entries.length > 0) {
        // Create a wallet totals object to sum credits per wallet.
        const walletTotals = {};
        raffle.entries.forEach(entry => {
          walletTotals[entry.walletAddress] = (walletTotals[entry.walletAddress] || 0) + entry.creditsAdded;
        });
        
        // If only one winner is set, use the single-winner logic.
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
          raffle.winnersList = []; // Clear any winnersList data if present.
        } else {
          // Multiple winners: pick unique winners using weighted random selection.
          const winners = [];
          // Clone walletTotals so we can modify it without affecting the original data.
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
              // Remove the winning wallet so they cannot win again.
              delete availableWallets[chosenWallet];
            }
          }
          // For backwards compatibility, if only one winner is chosen, save it to raffle.winner.
          raffle.winner = winners.length === 1 ? winners[0] : null;
          raffle.winnersList = winners;
        }
      } else {
        // No entries were made.
        raffle.winner = "No Entries";
        raffle.winnersList = [];
      }
      raffle.status = "completed";
      raffle.completedAt = now;
      await raffle.save();
      if (raffle.winnersList && raffle.winnersList.length > 0) {
        console.log(`Raffle ${raffle.raffleId} completed. Winners: ${raffle.winnersList.join(', ')}`);
      } else {
        console.log(`Raffle ${raffle.raffleId} completed. Winner: ${raffle.winner}`);
      }
    }
  } catch (err) {
    console.error('Error in completing raffles:', err);
  }
}

// Schedule the job to run every minute
cron.schedule('* * * * *', async () => {
  console.log('Running raffle completion scheduler...');
  await completeExpiredRaffles();
});

console.log('Raffle completion scheduler started.');
