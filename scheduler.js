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
 * Now not needed if you store a separate transaction private key.
 */
function formatXPrv(xprv) {
  if (typeof xprv === 'string' && xprv.startsWith('xprv')) {
    return xprv.slice(4);
  }
  return xprv;
}

async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Updated query: raffles that are live (expired) OR completed but missing prize or generated tokens dispersal.
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
        // Calculate generated tokens using DB values:
        // generatedTokens = totalEntries * creditConversion
        const generatedTokens = raffle.totalEntries * raffle.creditConversion;
        
        if (raffle.type === 'KRC20') {
          // Top-up: Ensure raffle wallet has at least 20 KAS (increased threshold for gas fees).
          let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          if (kasBalanceKAS < 20) {
            const needed = 20 - kasBalanceKAS;
            // Top-up uses treasury key.
            const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
            console.log(`Sent extra ${needed} KAS to raffle wallet for gas: ${txidExtra}`);
            await sleep(10000);
          }
          if (generatedTokens > 0) {
            const feeTokens = Math.floor(generatedTokens * 0.05);
            const creatorTokens = generatedTokens - feeTokens;
            // Use the stored transaction private key for signing.
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
          if (remainingKAS > 0) {
            const raffleKey = raffle.wallet.transactionPrivateKey;
            const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
            console.log(`Sent remaining KAS from raffle wallet to treasury: ${txidRemaining}`);
            await sleep(10000);
          }
        } else if (raffle.type === 'KAS') {
          // For KAS raffles, ensure at least 3 KAS in the raffle wallet.
          let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          if (kasBalanceKAS < 3) {
            const needed = 3 - kasBalanceKAS;
            // Top-up uses treasury key.
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
        }
        raffle.generatedTokensDispersed = true;
        await raffle.save();
        console.log(`Generated tokens dispersed for raffle ${raffle.raffleId}`);
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
