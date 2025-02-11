// ----- PART 2: Generated Tokens Dispersal -----
if (!raffle.generatedTokensDispersed) {
  // Compute generated tokens from the DB:
  const generatedTokens = raffle.totalEntries * raffle.creditConversion;
  if (raffle.type === 'KRC20') {
    // Ensure the raffle wallet has at least 15 KAS.
    let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
    let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
    if (kasBalanceKAS < 15) {
      const needed = 15 - kasBalanceKAS;
      // Use sendKaspa with the raffle wallet’s private key to top-up.
      const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed, raffle.wallet.xPrv);
      console.log(`Sent extra ${needed} KAS to raffle wallet for gas: ${txidExtra}`);
      await sleep(10000);
    }
    if (generatedTokens > 0) {
      const feeTokens = Math.floor(generatedTokens * 0.05);
      const creatorTokens = generatedTokens - feeTokens;
      // Send fee (5%) from raffle wallet to treasury using raffle wallet's private key.
      const txidFee = await sendKRC20(raffle.treasuryAddress, feeTokens, raffle.tokenTicker, raffle.wallet.xPrv);
      console.log(`Sent fee (5%) from raffle wallet to treasury: ${txidFee}`);
      await sleep(10000);
      // Send remainder (95%) from raffle wallet to creator.
      const txidCreator = await sendKRC20(raffle.creator, creatorTokens, raffle.tokenTicker, raffle.wallet.xPrv);
      console.log(`Sent tokens (95%) from raffle wallet to creator: ${txidCreator}`);
      await sleep(10000);
    }
    // Send any remaining KAS (above 15 KAS) from raffle wallet back to treasury.
    kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
    kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
    const remainingKAS = kasBalanceKAS > 15 ? kasBalanceKAS - 15 : 0;
    if (remainingKAS > 0) {
      const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffle.wallet.xPrv);
      console.log(`Sent remaining KAS from raffle wallet to treasury: ${txidRemaining}`);
      await sleep(10000);
    }
  } else if (raffle.type === 'KAS') {
    // For KAS raffles, ensure at least 3 KAS are in the raffle wallet.
    let kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
    let kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
    if (kasBalanceKAS < 3) {
      const needed = 3 - kasBalanceKAS;
      const txidExtra = await sendKaspa(raffle.wallet.receivingAddress, needed, raffle.wallet.xPrv);
      console.log(`Sent extra ${needed} KAS to raffle wallet for gas (KAS raffle): ${txidExtra}`);
      await sleep(10000);
    }
    // Send any remaining KAS above 3 KAS from raffle wallet to treasury.
    kasBalanceRes = await axios.get(`https://api.kaspa.org/addresses/${raffle.wallet.receivingAddress}/balance`);
    kasBalanceKAS = kasBalanceRes.data.balance / 1e8;
    const remainingKAS = kasBalanceKAS > 3 ? kasBalanceKAS - 3 : 0;
    if (remainingKAS > 0) {
      const txidRemaining = await sendKaspa(raffle.treasuryAddress, remainingKAS, raffle.wallet.xPrv);
      console.log(`Sent remaining KAS from raffle wallet to treasury (KAS raffle): ${txidRemaining}`);
      await sleep(10000);
    }
  }
  raffle.generatedTokensDispersed = true;
  await raffle.save();
  console.log(`Generated tokens dispersed for raffle ${raffle.raffleId}`);
}
