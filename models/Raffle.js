const mongoose = require('mongoose');

const RaffleSchema = new mongoose.Schema({
  raffleId: { type: String, unique: true, required: true },
  creator: { type: String, required: true }, // stores creator wallet address
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
  entries: [{
    walletAddress: String,
    txid: { type: String, sparse: true },  // Use sparse index so that null values aren’t enforced for uniqueness
    amount: Number,
    confirmedAt: Date,
  }],
  totalEntries: { type: Number, default: 0 },
  currentEntries: { type: Number, default: 0 },
  processedTransactions: { type: Array, default: [] }
});

module.exports = mongoose.model('Raffle', RaffleSchema);
