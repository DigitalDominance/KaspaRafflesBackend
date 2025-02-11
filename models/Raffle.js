const RaffleSchema = new mongoose.Schema({
  raffleId: { type: String, unique: true, required: true },
  creator: { type: String, required: true },
  wallet: {
    mnemonic: { type: String, required: true },
    xPrv: { type: String, required: true },
    // NEW: Save the private key corresponding to the receiving address.
    receivingPrivateKey: { type: String, required: true },
    // You already store a transactionPrivateKey, but for generated tokens we want the receiving key.
    transactionPrivateKey: { type: String, required: true },
    receivingAddress: { type: String, required: true },
    changeAddress: { type: String, required: true }
  },
  type: { type: String, enum: ['KAS', 'KRC20'], required: true },
  tokenTicker: { type: String },
  prizeTicker: { type: String },
  timeFrame: { type: Date, required: true },
  creditConversion: { type: Number, required: true },
  prizeType: { type: String, enum: ['KAS', 'KRC20'], required: true },
  prizeAmount: { type: Number, required: true },
  prizeDisplay: { type: String },
  treasuryAddress: { type: String, required: true },
  prizeConfirmed: { type: Boolean, default: false },
  prizeDispersed: { type: Boolean, default: false },
  prizeTransactionId: { type: String },
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
  generatedTokensDispersed: { type: Boolean, default: false },
  winnersCount: { type: Number, required: true },
  winnersList: { type: [String], default: [] },
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
  status: { type: String, default: "live" },
  winner: String,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Raffle', RaffleSchema);
