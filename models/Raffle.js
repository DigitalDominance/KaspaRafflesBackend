const mongoose = require('mongoose');

const RaffleSchema = new mongoose.Schema({
  raffleId: { type: String, unique: true, required: true },
  creator: { type: String, required: true }, // Wallet address of the raffle creator
  wallet: {
    mnemonic: { type: String, required: true },
    xPrv: { type: String, required: true },
    receivingAddress: { type: String, required: true },
    changeAddress: { type: String, required: true }
  },
  type: { type: String, enum: ['KAS', 'KRC20'], required: true },
  tokenTicker: { type: String },  // Only defined if type is KRC20
  timeFrame: { type: Date, required: true },
  creditConversion: { type: Number, required: true },  // Dynamic conversion (e.g., 100 or 1000)
  prize: { type: String },
  createdAt: { type: Date, default: Date.now },
  entries: [{
    walletAddress: String,
    txid: { type: String, sparse: true },
    amount: Number,
    confirmedAt: Date,
  }],
  totalEntries: { type: Number, default: 0 },
  currentEntries: { type: Number, default: 0 },
  processedTransactions: { type: Array, default: [] }
});

module.exports = mongoose.model('Raffle', RaffleSchema);
