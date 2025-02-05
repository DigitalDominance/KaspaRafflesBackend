const mongoose = require('mongoose');

const RaffleSchema = new mongoose.Schema({
  raffleId: { type: String, unique: true, required: true },
  creator: { type: String, required: true }, // <-- NEW: stores creator wallet address
  wallet: {
    mnemonic: { type: String, required: true },
    xPrv: { type: String, required: true },
    receivingAddress: { type: String, required: true },
    changeAddress: { type: String, required: true }
  },
  type: { type: String, enum: ['KAS', 'KRC20'], required: true },
  tokenTicker: { type: String },
  timeFrame: { type: Date, required: true },
  creditConversion: { type: Number, required: true },
  // creditConversion is the number of tokens needed per raffle entry.
  prize: { type: String },
  createdAt: { type: Date, default: Date.now },
  entries: [{
    walletAddress: String,
    txid: { type: String, unique: true },
    amount: Number,
    confirmedAt: Date,
  }],
  totalEntries: { type: Number, default: 0 },
  currentEntries: { type: Number, default: 0 },
  processedTransactions: { type: Array, default: [] }
});

module.exports = mongoose.model('Raffle', RaffleSchema);
