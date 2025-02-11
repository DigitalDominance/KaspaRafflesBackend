const cron = require('node-cron');
const axios = require('axios');
const Raffle = require('./models/Raffle');
const { sendKaspa, sendKRC20 } = require('./wasm_rpc');

// Helper function to pause execution (wait n milliseconds)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * (Optional) Helper function to remove the "xprv" prefix.
 * Not needed if you store a separate transaction private key.
 */
function formatXPrv(xprv) {
  if (typeof xprv === 'string' && xprv.startsWith('xprv')) {
    return xprv.slice(4);
  }
  return xprv;
}

/**
 * Helper function to get the human-readable KRC-20 token balance for an address.
 * The API returns the balance in smallest units, so we divide by 1e8.
 * 
 * @param {string} address - The wallet address.
 * @param {string} tick - The token symbol.
 * @returns {Promise<number>} - The token balance in human-readable form.
 */
async function getKRC20Balance(address, tick) {
  try {
    const url = `https://api.kasplex.org/v1/krc20/address/${encodeURIComponent(address)}/token/${encodeURIComponent(tick)}`;
    const response = await axios.get(url);
    if (response.data && response.data.result && response.data.result.length > 0) {
      const tokenInfo = response.data.result[0];
      // tokenInfo.balance is a string; convert to number.
      const rawBalance = BigInt(tokenInfo.balance);
      // Divide by 1e8 to get human-readable amount.
      const humanBalance = Number(rawBalance) / 1e8;
      return humanBalance;
    } else {
      throw new Error("Token balance not found in API response");
    }
  } catch (err) {
    console.error(`Error fetching KRC-20 balance for ${address} (${tick}): ${err.message}`);
    throw err;
  }
}

async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Query: raffles that are live (expired) OR completed but missing prize or generated tokens dispersal.
    const rafflesToProcess = await Raffle.find({
      $or: [
        { status: "live", timeFrame: { $lte: now } },
        { status: "completed", $or: [ { prizeDispersed: false }, { generatedTokensDispersed: false } ] }
      ]
    });
    console.log(`Found ${rafflesToProcess.length} raffles to process.`);

    for (const raffle of rafflesToProcess) {
      // ----- PART 1: Winner Selection and Prize Dispersal -----
      if (raffle.status === "live") {
        if (raffle.entries && raffle.entries.length > 0) {
          const walletTotals = {};
          raffle.entries.forEach(entry => {
            walletTotals[entry.walletAddress] = (walletTotals[entry.walletAddress] || 0) + entry.creditsAdded;
          });
          if (raffle.winnersCount === 1) {
            const totalCredits = Object.values(walletTotals).reduce((sum, val) => sum + val, 0);
            let random = Math.random() * totalCredits;
            let chosen = null;
            for (const [wallet, credits] of Object.entries(walletTotals)) {
              random -= credits;
              if (random <= 0) {
                chosen = wallet;
                break;
              }
            }
            raffle.winner = chosen;
            raffle.winnersList = [];
          } else {
            const winners = [];
            const availableWallets = { ...walletTotals };
            const maxWinners = Math.min(raffle.winnersCount, Object.keys(availableWallets).length);
            for (let i = 0; i < maxWinners; i++) {
              const totalCredits = Object.values(availableWallets).reduce((sum, val) => sum + val, 0);
              let random = Math.random() * totalCredits;
              let chosenWallet = null;
              for (const [wallet, credits] of Object.entries(availableWallets)) {
                random -= credits;
                if (random <= 0) {
                  chosenWallet = wallet;
                  break;
                }
              }
              if (chosenWallet) {
                winners.push(chosenWallet);
                delete availableWallets[chosenWallet];
              }
            }
            raffle.winner = winners.length === 1 ? winners[0] : null;
            raffle.winnersList = winners;
          }
          raffle.status = "completed";
          raffle.completedAt = now;
          await raffle.save();
        } else {
          raffle.winner = "No Entries";
          raffle.winnersList = [];
          raffle.status = "completed";
          raffle.completedAt = now;
          await raffle.save();
        }
      }

      // Prize Dispersal for Winners
      let winnersArray = [];
      if (raffle.winnersList && raffle.winnersList.length > 0) {
        winnersArray = raffle.winnersList;
      } else if (raffle.winner && raffle.winner !== "No Entries") {
        winnersArray = [raffle.winner];
      }
      if (winnersArray.length > 0) {
        const totalPrize = raffle.prizeAmount;
        const perWinnerPrize = totalPrize / winnersArray.length;
        let allTxSuccess = true;
        const alreadyProcessed = raffle.prizeDispersalTxids.map(tx => tx.winnerAddress);
        for (const winnerAddress of winnersArray) {
          if (alreadyProcessed.includes(winnerAddress)) {
            console.log(`Prize already sent to ${winnerAddress}, skipping.`);
            continue;
          }
          try {
            let txid;
            if (raffle.prizeType === "KAS") {
              txid = await sendKaspa(winnerAddress, perWinnerPrize);
            } else if (raffle.prizeType === "KRC20") {
              txid = await sendKRC20(winnerAddress, perWinnerPrize, raffle.prizeTicker);
            }
            console.log(`Sent prize to ${winnerAddress}. Transaction ID: ${txid}`);
            raffle.processedTransactions.push({
              txid,
              coinType: raffle.prizeType,
              amount: perWinnerPrize,
              winnerAddress,
              timestamp: new Date()
            });
            raffle.prizeDispersalTxids.push({ winnerAddress, txid, timestamp: new Date() });
            await sleep(10000);
          } catch (err) {
            console.error(`Error sending prize to ${winnerAddress}: ${err.message}`);
            allTxSuccess = false;
          }
        }
        const allProcessed = winnersArray.every(
          winnerAddress => raffle.prizeDispersalTxids.some(tx => tx.winnerAddress === winnerAddress)
        );
        if (allProcessed && allTxSuccess) {
          raffle.prizeConfirmed = true;
          raffle.prizeDispersed = true;
        } else {
          raffle.prizeDispersed = false;
        }
        await raffle.save();
        if (allProcessed && allTxSuccess) {
          console.log(`Raffle ${raffle.raffleId} completed. All prizes dispersed successfully.`);
        } else {
          console.log(`Raffle ${raffle.raffleId} completed. Some prize transactions failed; successful ones will not be resent.`);
        }
      } else {
        console.log(`Raffle ${raffle.raffleId} completed. No valid entries for prize distribution.`);
      }

      // ----- PART 2: Generated Tokens Dispersal -----
      if (!raffle.generatedTokensDispersed) {
        // For KRC20 raffles, we now query the Kasplex API to get the actual KRC20 token balance.
        if (raffle.type === 'KRC20') {
          try {
            const tokenUrl = `https://api.kasplex.org/v1/krc20/address/${encodeURIComponent(raffle.wallet.receivingAddress)}/token/${encodeURIComponent(raffle.tokenTicker)}`;
            const tokenRes = await axios.get(tokenUrl);
            if (tokenRes.data && tokenRes.data.result && tokenRes.data.result.length > 0) {
              const tokenInfo = tokenRes.data.result[0];
              // tokenInfo.balance is a string representing the smallest unit.
              const rawBalance = BigInt(tokenInfo.balance);
              const generatedTokens = Number(rawBalance) / 1e10; // human-readable amount
              console.log(`Raffle ${raffle.raffleId}: KRC20 generated token balance from API: ${generatedTokens}`);
              
              // Top-up: Ensure raffle wallet has at least 20 KAS for gas.
              let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
              let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
              console.log(`Raffle ${raffle.raffleId}: raffle wallet KAS balance before top-up: ${kasBalanceKAS}`);
              if (kasBalanceKAS < 20) {
                const needed = 20 - kasBalanceKAS;
                const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
                console.log(`Sent extra ${needed} KAS to raffle wallet for gas: ${txidExtra}`);
                await sleep(10000);
              }
              if (generatedTokens > 0) {
                const feeTokens = Math.floor(generatedTokens * 0.05);
                const creatorTokens = Math.floor(generatedTokens * 0.95);
                console.log(`Raffle ${raffle.raffleId}: feeTokens=${feeTokens}, creatorTokens=${creatorTokens}`);
                // Use the stored transaction private key for signing from the raffle wallet.
                const raffleKey = raffle.wallet.transactionPrivateKey;
                // Send fee (5%) from raffle wallet to treasury.
                const txidFee = await sendKRC20(raffle.treasuryAddress, feeTokens, raffle.tokenTicker, raffleKey);
                console.log(`Sent fee (5%) from raffle wallet to treasury: ${txidFee}`);
                await sleep(10000);
                // Send remainder (95%) from raffle wallet to creator.
                const txidCreator = await sendKRC20(raffle.creator, creatorTokens, raffle.tokenTicker, raffleKey);
                console.log(`Sent tokens (95%) from raffle wallet to creator: ${txidCreator}`);
                await sleep(10000);
              }
              // Return remaining KAS (above 20 KAS) from raffle wallet to treasury.
              kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
              kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
              const remainingKAS = kasBalanceKAS > 20 ? kasBalanceKAS - 20 : 0;
              console.log(`Raffle ${raffle.raffleId}: remaining KAS in raffle wallet: ${remainingKAS}`);
              if (remainingKAS > 0) {
                const raffleKey = raffle.wallet.transactionPrivateKey;
                const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
                console.log(`Sent remaining KAS from raffle wallet to treasury: ${txidRemaining}`);
                await sleep(10000);
              }
              raffle.generatedTokensDispersed = true;
              await raffle.save();
              console.log(`Generated tokens dispersed for raffle ${raffle.raffleId}`);
            } else {
              console.log(`No KRC20 token data found for raffle wallet ${raffle.wallet.receivingAddress} with ticker ${raffle.tokenTicker}`);
            }
          } catch (err) {
            console.error(`Error fetching KRC20 balance: ${err.message}`);
          }
        } else if (raffle.type === 'KAS') {
          // For KAS raffles, use the previous logic.
          let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          if (kasBalanceKAS < 3) {
            const needed = 3 - kasBalanceKAS;
            const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
            console.log(`Sent extra ${needed} KAS to raffle wallet for gas (KAS raffle): ${txidExtra}`);
            await sleep(10000);
          }
          kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          const remainingKAS = kasBalanceKAS > 3 ? kasBalanceKAS - 3 : 0;
          if (remainingKAS > 0) {
            const raffleKey = raffle.wallet.transactionPrivateKey;
            const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
            console.log(`Sent remaining KAS from raffle wallet to treasury (KAS raffle): ${txidRemaining}`);
            await sleep(10000);
          }
          raffle.generatedTokensDispersed = true;
          await raffle.save();
          console.log(`Generated tokens dispersed for raffle ${raffle.raffleId}`);
        }
      }
    }
  } catch (err) {
    console.error('Error in completing raffles:', err);
  }
}

// Schedule the job to run every minute.
cron.schedule('* * * * *', async () => {
  console.log('Running raffle completion scheduler...');
  await completeExpiredRaffles();
});

console.log('Raffle completion scheduler started.');
