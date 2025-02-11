const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { createWallet } = require('../wasm_rpc');
const Raffle = require('../models/Raffle');
const axios = require('axios');

// Helper: Validate ticker for KRC20 raffles.
async function validateTicker(ticker) {
  try {
    const formattedTicker = ticker.trim().toUpperCase();
    const url = `https://api.kasplex.org/v1/krc20/token/${formattedTicker}`;
    const response = await axios.get(url);
    console.log("Token info for", formattedTicker, ":", response.data);
    if (
      response.data &&
      response.data.result &&
      response.data.result.length > 0
    ) {
      const tokenInfo = response.data.result[0];
      // For our system, a token is considered valid if its state is 'finished'
      return tokenInfo.state.toLowerCase() === 'finished';
    }
    return false;
  } catch (err) {
    console.error('Error validating ticker:', err.message);
    return false;
  }
}

// Create Raffle endpoint: Accepts raffle and prize details.
router.post('/create', async (req, res) => {
  try {
    const {
      type,
      tokenTicker,
      timeFrame,
      creditConversion,
      prizeType,
      prizeAmount,
      winnersCount
    } = req.body;
    const creator = req.body.creator;
    const treasuryAddress = req.body.treasuryAddress;

    if (!type || !timeFrame || !creditConversion || !creator || !prizeType || !prizeAmount || !treasuryAddress || winnersCount === undefined) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (type === 'KRC20') {
      if (!tokenTicker) {
        return res.status(400).json({ error: 'KRC20 raffles require a token ticker' });
      }
      const validTicker = await validateTicker(tokenTicker);
      if (!validTicker) {
        return res.status(400).json({ error: 'Invalid or un-deployed token ticker' });
      }
    }

    const walletData = await createWallet();
    if (!walletData.success) {
      return res.status(500).json({ error: 'Error creating raffle wallet: ' + walletData.error });
    }

    let prizeDisplay = "";
    if (prizeType === "KAS") {
      prizeDisplay = `${prizeAmount} KAS`;
    } else {
      const prizeTicker = req.body.prizeTicker ? req.body.prizeTicker.trim().toUpperCase() : "";
      prizeDisplay = `${prizeAmount} ${prizeTicker}`;
    }

    const raffleId = uuidv4();
    const raffle = new Raffle({
      raffleId,
      creator,
      wallet: {
        mnemonic: walletData.mnemonic,
        xPrv: walletData.xPrv,
        // Save both keys if needed. For generated tokens, we'll use receivingPrivateKey.
        receivingPrivateKey: walletData.receivingPrivateKey,
        transactionPrivateKey: walletData.transactionPrivateKey,
        receivingAddress: walletData.receivingAddress,
        changeAddress: walletData.changeAddress,
      },
      type,
      tokenTicker: type === 'KRC20' ? tokenTicker.trim().toUpperCase() : undefined,
      prizeTicker: prizeType === 'KRC20' ? req.body.prizeTicker.trim().toUpperCase() : undefined,
      timeFrame,
      creditConversion,
      prizeType,
      prizeAmount,
      prizeDisplay,
      treasuryAddress,
      winnersCount: parseInt(winnersCount, 10),
      winnersList: []
    });


    await raffle.save();
    res.json({ success: true, raffleId, wallet: walletData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});

// Prize Confirmation endpoint: Updates prizeConfirmed and saves the TXID.
router.post('/:raffleId/confirmPrize', async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ raffleId: req.params.raffleId });
    if (!raffle) return res.status(404).json({ error: 'Raffle not found' });

    const { txid } = req.body;
    if (!txid) {
      return res.status(400).json({ error: 'Prize transaction ID not provided' });
    }

    raffle.prizeConfirmed = true;
    raffle.prizeTransactionId = txid;
    await raffle.save();
    res.json({ success: true, raffle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Record a raffle entry.
router.post('/:raffleId/enter', async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ raffleId: req.params.raffleId });
    if (!raffle) return res.status(404).json({ error: 'Raffle not found' });

    // Only allow entries if the raffle is still live.
    if (raffle.status !== "live") {
      return res.status(400).json({ error: 'Raffle is no longer live' });
    }

    const { txid, walletAddress, amount } = req.body;
    if (!txid || !walletAddress || !amount) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    // Calculate credits based on the conversion rate.
    const creditsToAdd = amount / parseFloat(raffle.creditConversion);

    raffle.currentEntries += creditsToAdd;
    raffle.totalEntries += creditsToAdd;

    // Update the entries array.
    const existingEntry = raffle.entries.find(e => e.walletAddress === walletAddress);
    if (existingEntry) {
      existingEntry.creditsAdded += creditsToAdd;
      existingEntry.amount += amount;
      existingEntry.confirmedAt = new Date();
    } else {
      raffle.entries.push({
        walletAddress,
        txid,
        creditsAdded: creditsToAdd,
        amount,
        confirmedAt: new Date()
      });
    }

    raffle.processedTransactions.push({
      txid,
      coinType: raffle.type === 'KAS' ? 'KAS' : raffle.tokenTicker,
      amount,
      creditsAdded: creditsToAdd,
      timestamp: new Date()
    });

    await raffle.save();
    res.json({ success: true, raffle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET details for a single raffle.
router.get('/:raffleId', async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ raffleId: req.params.raffleId });
    if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
    res.json({ success: true, raffle });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});

// GET list of raffles.
// If a query parameter "creator" is provided, filter by that; otherwise, show live raffles or completed within last (NOW 24 HOURS)
router.get('/', async (req, res) => {
  try {
    let query = {};
    if (req.query.creator) {
      query.creator = req.query.creator;
    } else {
      const twelveHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      query = {
        $or: [
          { status: "live" },
          { status: "completed", completedAt: { $gte: twelveHoursAgo } }
        ]
      };
    }
    const raffles = await Raffle.find(query).sort({ currentEntries: -1 });
    res.json({ success: true, raffles });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});

module.exports = router;
