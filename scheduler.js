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

async function completeExpiredRaffles() {
  try {
    const now = new Date();
    // Query raffles that are either live (expired) OR completed but missing prize or generated tokens dispersal.
    const rafflesToProcess = await Raffle.find({
      $or: [
        { status: "live", timeFrame: { $lte: now } },
        { status: "completed", $or: [{ prizeDispersed: false }, { generatedTokensDispersed: false }] }
      ]
    });
    console.log(`Found ${rafflesToProcess.length} raffles to process.`);

    // ----- PART 1: Winner Selection and Prize Dispersal -----
    for (const raffle of rafflesToProcess) {
      // If raffle is still live, select winners and mark as completed.
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
      // Use an in-progress flag to prevent re-triggering this section within the same minute.
      if (!raffle.generatedTokensDispersed && !raffle.generatedTokensDispersalInProgress) {
        raffle.generatedTokensDispersalInProgress = true;
        await raffle.save();
        
        if (raffle.type === 'KRC20') {
          try {
            const tokenUrl = `https://api.kasplex.org/v1/krc20/address/${encodeURIComponent(raffle.wallet.receivingAddress)}/token/${encodeURIComponent(raffle.tokenTicker)}`;
            const tokenRes = await axios.get(tokenUrl);
            if (tokenRes.data && tokenRes.data.result && tokenRes.data.result.length > 0) {
              const tokenInfo = tokenRes.data.result[0];
              const rawBalance = BigInt(tokenInfo.balance);
              const generatedTokens = Number(rawBalance) / 1e8; // human-readable amount
              console.log(`Raffle ${raffle.raffleId}: Fetched KRC20 generated token balance: ${generatedTokens}`);
      
              // Top-up: Ensure raffle wallet has at least 15 KAS for gas.
              let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
              let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
              console.log(`Raffle ${raffle.raffleId}: Raffle wallet KAS balance before top-up: ${kasBalanceKAS}`);
              if (kasBalanceKAS < 15) {
                const needed = 15 - kasBalanceKAS;
                const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
                console.log(`Sent extra ${needed} KAS to raffle wallet for gas: ${txidExtra}`);
                await sleep(6500);
              }
              if (generatedTokens > 0) {
                const feeTokens = generatedTokens * 0.05;
                const creatorTokens = generatedTokens - feeTokens;
                console.log(`Raffle ${raffle.raffleId}: feeTokens=${feeTokens}, creatorTokens=${creatorTokens}`);
                // Use the receivingPrivateKey from the raffle wallet.
                const raffleKey = raffle.wallet.receivingPrivateKey;
                console.log(`Using raffle wallet receiving private key: ${raffleKey}`);
                const txidFee = await sendKRC20(raffle.treasuryAddress, feeTokens, raffle.tokenTicker, raffleKey);
                console.log(`Sent fee (5%) from raffle wallet to treasury: ${txidFee}`);
                await sleep(6500);
                const txidCreator = await sendKRC20(raffle.creator, creatorTokens, raffle.tokenTicker, raffleKey);
                console.log(`Sent tokens (95%) from raffle wallet to creator: ${txidCreator}`);
                await sleep(10000);
              }
              // Return remaining KAS (all funds minus 0.02 KAS for priority fee) from raffle wallet to treasury.
              kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
              kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
              console.log(`Raffle ${raffle.raffleId}: Total KAS in raffle wallet: ${kasBalanceKAS}`);
              const sendableKAS = kasBalanceKAS > 0.3 ? kasBalanceKAS - 0.3 : 0;
              if (sendableKAS > 0) {
                const raffleKey = raffle.wallet.receivingPrivateKey;
                const txidRemaining = await sendKaspa(raffle.treasuryAddress, sendableKAS, raffleKey);
                console.log(`Sent remaining KAS from raffle wallet to treasury: ${txidRemaining}`);
                await sleep(6500);
              }
              raffle.generatedTokensDispersed = true;
              raffle.generatedTokensDispersalInProgress = false;
              await raffle.save();
              console.log(`Generated tokens dispersed for raffle ${raffle.raffleId}`);
            } else {
              console.log(`No KRC20 token data found for raffle wallet ${raffle.wallet.receivingAddress} with ticker ${raffle.tokenTicker}`);
              raffle.generatedTokensDispersalInProgress = false;
              await raffle.save();
            }
          } catch (err) {
            console.error(`Error fetching KRC20 balance: ${err.message}`);
            raffle.generatedTokensDispersalInProgress = false;
            await raffle.save();
          }
        } else if (raffle.type === 'KAS') {
          let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          if (kasBalanceKAS < 3) {
            const needed = 3 - kasBalanceKAS;
            const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed);
            console.log(`Sent extra ${needed} KAS to raffle wallet for gas (KAS raffle): ${txidExtra}`);
            await sleep(6700);
          }
          kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
          kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
          const remainingKAS = kasBalanceKAS > 0.3 ? kasBalanceKAS - 0.3 : 0;
          if (remainingKAS > 0) {
            const raffleKey = raffle.wallet.receivingPrivateKey;
            const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
            console.log(`Sent remaining KAS from raffle wallet to treasury (KAS raffle): ${txidRemaining}`);
            await sleep(6700);
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
