const mongoose = require('mongoose');

const RaffleSchema = new mongoose.Schema({
  raffleId: { type: String, unique: true, required: true },
  creator: { type: String, required: true },
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
  prize: { type: String },
  createdAt: { type: Date, default: Date.now },
  // Each entry is a transaction processed from deposits.
  entries: [{
    walletAddress: String,
    txid: { type: String, sparse: true },
    // We'll store the “credits” added from each transaction (could be fractional).
    creditsAdded: Number,
    amount: Number,
    confirmedAt: Date,
  }],
  totalEntries: { type: Number, default: 0 },
  currentEntries: { type: Number, default: 0 },
  processedTransactions: { type: Array, default: [] },
  status: { type: String, default: "live" },        // "live" or "completed"
  completedAt: Date,
  winner: String
});

module.exports = mongoose.model('Raffle', RaffleSchema);
