/**
 * Trading wallet CLI — key material is only ever shown in your terminal, never over HTTP.
 *   npm run wallet            show address + balance
 *   npm run wallet -- export  print the private key (base58) to import into Phantom/Solflare
 *   npm run wallet -- import <base58-or-json-array>
 */
import bs58 from 'bs58';
import { connectDb, disconnectDb } from '../db/prisma.js';
import { ensureTradingWallet, getTradingKeypair, getSolBalance, importTradingKey } from '../services/solana.js';

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  await connectDb();

  if (cmd === 'import') {
    if (!arg) throw new Error('Usage: npm run wallet -- import <secret>');
    console.log(`Imported trading wallet: ${await importTradingKey(arg)}`);
  } else if (cmd === 'export') {
    const kp = await getTradingKeypair();
    if (!kp) throw new Error('No trading wallet yet — start the bot once');
    console.log(`Address:     ${kp.publicKey.toBase58()}`);
    console.log(`Private key: ${bs58.encode(kp.secretKey)}`);
    console.log('\n⚠  Anyone with this key controls the funds. Do not paste it anywhere else.');
  } else {
    const address = await ensureTradingWallet();
    const bal = await getSolBalance(address);
    console.log(`Trading wallet: ${address}`);
    console.log(`Balance:        ${bal === null ? 'unavailable' : bal.toFixed(4) + ' SOL'}`);
  }
  await disconnectDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err.message);
  await disconnectDb();
  process.exit(1);
});
