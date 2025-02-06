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
    if (response.data && response.data.result && response.data.result.length > 0) {
      const tokenInfo = response.data.result[0];
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
      prizeAmount
    } = req.body;
    const creator = req.body.creator;
    const treasuryAddress = req.body.treasuryAddress;
    
    if (!type || !timeFrame || !creditConversion || !creator || !prizeType || !prizeAmount || !treasuryAddress) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Check that timeFrame is in the future.
    if (new Date(timeFrame) <= new Date()) {
      return res.status(400).json({ error: 'Time frame cannot be in the past' });
    }
    // Check that raffle duration is at least 24 hours.
    if (new Date(timeFrame) < new Date(Date.now() + 24 * 60 * 60 * 1000)) {
      return res.status(400).json({ error: 'Raffle must last at least 24 hours' });
    }
    // Check that timeFrame does not exceed maximum of 5 days.
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
    
    // Compute prizeDisplay.
    let prizeDisplay = "";
    if (prizeType === "KAS") {
      prizeDisplay = `${prizeAmount} KAS`;
    } else {
      // For prizeType KRC20, use prizeTicker (should be provided)
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

// Other endpoints below…

module.exports = router;
