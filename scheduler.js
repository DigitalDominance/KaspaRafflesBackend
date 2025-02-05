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
      // If there are entries, choose a winner weighted by the credits added.
      if (raffle.entries && raffle.entries.length > 0) {
        const walletTotals = {};
        raffle.entries.forEach(entry => {
          walletTotals[entry.walletAddress] = (walletTotals[entry.walletAddress] || 0) + entry.creditsAdded;
        });
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
      } else {
        raffle.winner = "No Entries";
      }
      raffle.status = "completed";
      raffle.completedAt = now;
      await raffle.save();
      console.log(`Raffle ${raffle.raffleId} completed. Winner: ${raffle.winner}`);
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
