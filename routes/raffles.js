const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { createWallet } = require('../wasm_rpc');
const Raffle = require('../models/Raffle');
const axios = require('axios');

/**
 * Validate a given token ticker using the Kasplex API.
 */
async function validateTicker(ticker) {
  try {
    const url = `https://tn10api.kasplex.org/v1/krc20/token/${ticker}`;
    const response = await axios.get(url);
    if (response.data && response.data.result && response.data.result.length > 0) {
      const tokenInfo = response.data.result[0];
      return tokenInfo.state === 'deployed';
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
    // Expecting the creator's wallet address from the frontend
    const { type, tokenTicker, timeFrame, creditConversion, prize, creator } = req.body;
    
    if (!type || !timeFrame || !creditConversion || !creator) {
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
    
    const raffleId = uuidv4();
    
    // Create a wallet for this raffle.
    const walletData = await createWallet();
    if (!walletData.success) {
      return res.status(500).json({ error: 'Error creating raffle wallet: ' + walletData.error });
    }
    
    const raffle = new Raffle({
      raffleId,
      creator, // <-- NEW: store the creator’s wallet address
      wallet: {
        mnemonic: walletData.mnemonic,
        xPrv: walletData.xPrv,
        receivingAddress: walletData.receivingAddress,
        changeAddress: walletData.changeAddress,
      },
      type,
      tokenTicker: type === 'KRC20' ? tokenTicker : undefined,
      timeFrame,
      creditConversion,
      prize,
    });
    
    await raffle.save();
    res.json({ success: true, raffleId, wallet: walletData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
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
 * List all raffles.
 */
router.get('/', async (req, res) => {
  try {
    // Optional filtering by creator: e.g., ?creator=...
    const query = req.query.creator ? { creator: req.query.creator } : {};
    const raffles = await Raffle.find(query).sort({ totalEntries: -1 });
    res.json({ success: true, raffles });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});

module.exports = router;
