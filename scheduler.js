const cron = require('node-cron');
const Raffle = require('./models/Raffle');
const { processRaffleTokenDeposits, processRaffleKaspaDeposits } = require('./depositProcessors');

async function completeRaffle(raffle) {
  // Aggregate entries by wallet address:
  const walletTotals = {};
  raffle.entries.forEach(entry => {
    const wallet = entry.walletAddress;
    walletTotals[wallet] = (walletTotals[wallet] || 0) + entry.creditsAdded;
  });
  const totalCredits = Object.values(walletTotals).reduce((sum, val) => sum + val, 0);
  if (totalCredits === 0) return; // No entries

  // Weighted random selection:
  let rand = Math.random() * totalCredits;
  let selected;
  for (const wallet in walletTotals) {
    rand -= walletTotals[wallet];
    if (rand <= 0) {
      selected = wallet;
      break;
    }
  }
  raffle.winner = selected;
  raffle.status = "completed";
  raffle.completedAt = new Date();
  console.log(`Raffle ${raffle.raffleId} completed. Winner: ${selected}`);
  await raffle.save();
}

async function scanAndCompleteRaffles() {
  try {
    const raffles = await Raffle.find({});
    console.log(`Scanning ${raffles.length} raffles for deposits and completion...`);
    for (const raffle of raffles) {
      // If raffle is live, scan for deposits:
      if (raffle.status === "live") {
        if (raffle.type === 'KAS') {
          await processRaffleKaspaDeposits(raffle);
        } else if (raffle.type === 'KRC20') {
          await processRaffleTokenDeposits(raffle);
        }
        // If time is up, complete the raffle.
        if (new Date() >= new Date(raffle.timeFrame)) {
          await completeRaffle(raffle);
        } else {
          await raffle.save();
        }
      }
    }
    console.log('Scanning and completion complete.');
  } catch (err) {
    console.error('Error in raffle scheduler:', err);
  }
}

// Run every minute.
cron.schedule('* * * * *', () => {
  console.log('Running scheduled raffle scan and completion...');
  scanAndCompleteRaffles();
});

console.log('Raffle scanning scheduler started.');
