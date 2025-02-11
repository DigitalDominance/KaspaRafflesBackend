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

    for (const raffle of rafflesToProcess) {
      // ----- PART 2: Generated Tokens Dispersal -----
      if (!raffle.generatedTokensDispersed && !raffle.generatedTokensDispersalInProgress) {
        // Mark as in progress to prevent re-triggering.
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
              const sendableKAS = kasBalanceKAS > 0.6 ? kasBalanceKAS - 0.6 : 0;
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
          // For KAS raffles, use the previous logic.
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
          const remainingKAS = kasBalanceKAS > 3 ? kasBalanceKAS - 3 : 0;
          if (remainingKAS > 0) {
            const raffleKey = raffle.wallet.receivingPrivateKey;
            const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffleKey);
            console.log(`Sent remaining KAS from raffle wallet to treasury (KAS raffle): ${txidRemaining}`);
            await sleep(6500);
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
