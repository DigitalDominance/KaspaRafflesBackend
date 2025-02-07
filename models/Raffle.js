// raffle.js
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
  tokenTicker: { type: String }, // Only for KRC20 raffles
  timeFrame: { type: Date, required: true },
  creditConversion: { type: Number, required: true },
  // Prize fields
  prizeType: { type: String, enum: ['KAS', 'KRC20'], required: true },
  prizeAmount: { type: Number, required: true },
  prizeDisplay: { type: String },  // computed string (e.g. "1000 KAS" or "500 NACHO")
  treasuryAddress: { type: String, required: true },
  prizeConfirmed: { type: Boolean, default: false },
  prizeTransactionId: { type: String },
  
  // New field for the number of winners to be selected
  winnersCount: { type: Number, required: true },
  // (Optional) If you want to store the actual winners (if multiple) as an array:
  winnersList: { type: [String], default: [] },

  // For deposit tracking (we will simply store txids that come instantly)
  entries: [{
    walletAddress: String,
    txid: { type: String, sparse: true },
    creditsAdded: Number,
    amount: Number,
    confirmedAt: Date,
  }],
  totalEntries: { type: Number, default: 0 },
  currentEntries: { type: Number, default: 0 },
  processedTransactions: { type: Array, default: [] },
  
  status: { type: String, default: "live" },  // "live" or "completed"
  // For backward compatibility if only one winner is used, you may leave this field.
  // Otherwise, use winnersList for multiple winners.
  winner: String,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Raffle', RaffleSchema);
