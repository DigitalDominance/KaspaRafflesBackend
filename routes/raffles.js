const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { createWallet } = require('../wasm_rpc');
const Raffle = require('../models/Raffle');
const axios = require('axios');
const { processRaffleTokenDeposits, processRaffleKaspaDeposits } = require('../depositProcessors');

/**
 * Validate a given token ticker using the Kasplex API.
 * Note: For tokens that are finished minting, check if the state is "finished".
 */
async function validateTicker(ticker) {
  try {
    const formattedTicker = ticker.trim().toUpperCase();
    const url = `https://api.kasplex.org/v1/krc20/token/${formattedTicker}`;
    const response = await axios.get(url);
    console.log("Token info for", formattedTicker, ":", response.data);
    if (response.data && response.data.result && response.data.result.length > 0) {
      const tokenInfo = response.data.result[0];
      // Instead of "deployed", use "finished" if that's what the API returns for tokens ready to be used.
      return tokenInfo.state.toLowerCase() === 'finished';
    }
    return false;
  } catch (err) {
    console.error('Error validating ticker:', err.message);
    return false;
  }
}

/**
 * POST /api/raffles/create
 * Create a new raffle.
 */
router.post('/create', async (req, res) => {
  try {
    const {
      type,
      tokenTicker,
      timeFrame,
      creditConversion,
      prizeType,
      prizeAmount
    } = req.body;
    const creator = req.body.creator;
    const treasuryAddress = req.body.treasuryAddress; // passed from frontend env variable

    if (!type || !timeFrame || !creditConversion || !creator || !prizeType || !prizeAmount || !treasuryAddress) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    if (new Date(timeFrame) <= new Date()) {
      return res.status(400).json({ error: 'Time frame cannot be in the past' });
    }
    if (new Date(timeFrame) > new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)) {
      return res.status(400).json({ error: 'Time frame exceeds maximum 5-day period' });
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
    
    // Create a wallet for this raffle.
    const walletData = await createWallet();
    if (!walletData.success) {
      return res.status(500).json({ error: 'Error creating raffle wallet: ' + walletData.error });
    }
    
    // Compute prize display string.
    let prizeDisplay = "";
    if (prizeType === "KAS") {
      prizeDisplay = `${prizeAmount} KAS`;
    } else {
      prizeDisplay = `${prizeAmount} ${tokenTicker.trim().toUpperCase()}`;
    }
    
    const raffleId = uuidv4();
    
    const raffle = new Raffle({
      raffleId,
      creator,
      wallet: {
        mnemonic: walletData.mnemonic,
        xPrv: walletData.xPrv,
        receivingAddress: walletData.receivingAddress,
        changeAddress: walletData.changeAddress,
      },
      type,
      tokenTicker: type === 'KRC20' ? tokenTicker.trim().toUpperCase() : undefined,
      timeFrame,
      creditConversion,
      prizeType,
      prizeAmount,
      prizeDisplay,
      treasuryAddress,
    });
    
    await raffle.save();
    res.json({ success: true, raffleId, wallet: walletData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});

// Prize Confirmation endpoint.
router.post('/:raffleId/confirmPrize', async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ raffleId: req.params.raffleId });
    if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
    
    // In a real implementation, scan the treasury wallet for a prize transaction.
    // For now, assume the host provides the prize transaction ID (txid) in the body.
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

/**
 * GET /api/raffles/:raffleId
 * Get details for a single raffle.
 */
router.get('/:raffleId', async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ raffleId: req.params.raffleId });
    if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
    res.json({ success: true, raffle });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});

/**
 * GET /api/raffles
 * List raffles. Optionally filter by creator.
 */
// In backend/routes/raffles.js:
router.get('/', async (req, res) => {
  try {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    // Show raffles that are live, or completed within the last 12 hours.
    const raffles = await Raffle.find({
      $or: [
        { status: "live" },
        { status: "completed", completedAt: { $gte: twelveHoursAgo } }
      ]
    }).sort({ currentEntries: -1 });
    res.json({ success: true, raffles });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});
/**
 * POST /api/raffles/:raffleId/process
 * Manually trigger processing for a raffle.
 */
router.post('/:raffleId/process', async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ raffleId: req.params.raffleId });
    if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
    
    if (raffle.type === 'KAS') {
      await processRaffleKaspaDeposits(raffle);
    } else if (raffle.type === 'KRC20') {
      await processRaffleTokenDeposits(raffle);
    }
    
    await raffle.save();
    res.json({ success: true, raffle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
