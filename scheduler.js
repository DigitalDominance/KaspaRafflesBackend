// backend/scheduler.js
const cron = require('node-cron');
const Raffle = require('./models/Raffle');
const { processRaffleTokenDeposits, processRaffleKaspaDeposits } = require('./depositProcessors');

async function scanAllRaffles() {
  try {
    const raffles = await Raffle.find({});
    console.log(`Scanning ${raffles.length} raffles for deposits...`);
    for (const raffle of raffles) {
      if (raffle.type === 'KAS') {
        await processRaffleKaspaDeposits(raffle);
      } else if (raffle.type === 'KRC20') {
        await processRaffleTokenDeposits(raffle);
      }
      await raffle.save();
    }
    console.log('Scanning complete.');
  } catch (err) {
    console.error('Error scanning raffles:', err);
  }
}

// Schedule the scan to run once every minute
cron.schedule('* * * * *', () => {
  console.log('Running scheduled raffle scan...');
  scanAllRaffles();
});

console.log('Raffle scanning scheduler started.');
