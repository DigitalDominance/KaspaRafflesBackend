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
  tokenTicker: { type: String }, // Only for KRC20 deposits (if used)
  prizeTicker: { type: String }, // NEW: for KRC20 prizes
  timeFrame: { type: Date, required: true },
  creditConversion: { type: Number, required: true },
  // Prize fields
  prizeType: { type: String, enum: ['KAS', 'KRC20'], required: true },
  prizeAmount: { type: Number, required: true },
  prizeDisplay: { type: String },  // computed string (e.g. "1000 KAS" or "500 NACHO")
  treasuryAddress: { type: String, required: true },
  prizeConfirmed: { type: Boolean, default: false },
  prizeDispersed: { type: Boolean, default: false }, // tracks if prizes have been successfully dispersed
  prizeTransactionId: { type: String },
  // NEW: Array to store prize dispersal TXIDs per winner.
  prizeDispersalTxids: { 
    type: [
      {
        winnerAddress: String,
        txid: String,
        timestamp: { type: Date, default: Date.now }
      }
    ],
    default: []
  },
  
  // New field for the number of winners to be selected
  winnersCount: { type: Number, required: true },
  winnersList: { type: [String], default: [] },

  // For deposit tracking
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
  winner: String,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Raffle', RaffleSchema);
