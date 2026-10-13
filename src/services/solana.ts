import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { env, solanaRpcUrl, WSOL_MINT, USDC_MINT, USDT_MINT } from '../config/index.js';
import { prisma } from '../db/prisma.js';
import { encryptSecret, decryptSecret, isEncrypted } from './secrets.js';
import { logger } from './logger.js';
import { recordApiEvent, isTimeoutError } from './apiHealth.js';

export const connection = new Connection(solanaRpcUrl, 'confirmed');

const isPublicRpc = solanaRpcUrl.includes('api.mainnet-beta.solana.com');
const RPC_PROVIDER = isPublicRpc ? 'solana-rpc-public' : 'helius-rpc';
const MIN_RPC_GAP_MS = isPublicRpc ? 150 : 25;
let lastRpcAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON-RPC call with a global throttle and retry on 429 / transient failures,
 * so scanner + profiler + monitor can share one rate-limited endpoint.
 */
export async function rpc<T = any>(method: string, params: any[], retries = 3): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = lastRpcAt + MIN_RPC_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRpcAt = Date.now();

    try {
      const res = await fetch(solanaRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429) {
        recordApiEvent(RPC_PROVIDER, '429', method);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as any;
      if (json.error) {
        logger.debug({ method, error: json.error }, 'RPC returned error');
        return null;
      }
      return json.result as T;
    } catch (err: any) {
      if (attempt === retries) {
        if (isTimeoutError(err)) recordApiEvent(RPC_PROVIDER, 'timeout', method);
        logger.debug({ method, err: err?.message }, 'RPC call failed');
        return null;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

// ─── Trading wallet ────────────────────────────────────────────────────────

function parseSecretKey(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

let cachedKeypair: Keypair | null = null;

/**
 * Make sure a dedicated trading wallet exists. SOLANA_PRIVATE_KEY in env wins;
 * otherwise a fresh keypair is generated once and stored encrypted in the DB.
 */
export async function ensureTradingWallet(): Promise<string> {
  const kp = await getTradingKeypair();
  if (kp) return kp.publicKey.toBase58();

  const fresh = Keypair.generate();
  const address = fresh.publicKey.toBase58();
  await prisma.botSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', mySolanaWallet: address, mySolanaPrivateKey: encryptSecret(bs58.encode(fresh.secretKey)) },
    update: { mySolanaWallet: address, mySolanaPrivateKey: encryptSecret(bs58.encode(fresh.secretKey)) },
  });
  await prisma.auditLog.create({
    data: { action: 'WALLET_CREATED', reason: 'Generated dedicated trading wallet', payload: { address } },
  });
  cachedKeypair = fresh;
  logger.warn({ address }, 'Generated new trading wallet — fund it with SOL to start trading');
  return address;
}

export async function getTradingKeypair(): Promise<Keypair | null> {
  if (cachedKeypair) return cachedKeypair;

  if (env.SOLANA_PRIVATE_KEY) {
    cachedKeypair = parseSecretKey(env.SOLANA_PRIVATE_KEY);
    return cachedKeypair;
  }

  const record = await prisma.botSetting.findUnique({ where: { id: 'default' } });
  if (!record?.mySolanaPrivateKey) return null;

  try {
    cachedKeypair = parseSecretKey(decryptSecret(record.mySolanaPrivateKey));
  } catch (err: any) {
    logger.error({ err: err?.message }, 'Stored trading wallet key could not be decrypted (wrong SECRETS_KEY?)');
    return null;
  }

  // Upgrade legacy plaintext keys and keep the public address in sync
  const address = cachedKeypair.publicKey.toBase58();
  if (!isEncrypted(record.mySolanaPrivateKey) || record.mySolanaWallet !== address) {
    await prisma.botSetting.update({
      where: { id: 'default' },
      data: { mySolanaPrivateKey: encryptSecret(decryptSecret(record.mySolanaPrivateKey)), mySolanaWallet: address },
    });
  }
  return cachedKeypair;
}

/** Replace the trading wallet (CLI import). Clears the cached keypair. */
export async function importTradingKey(secret: string): Promise<string> {
  const kp = parseSecretKey(secret);
  const address = kp.publicKey.toBase58();
  await prisma.botSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', mySolanaWallet: address, mySolanaPrivateKey: encryptSecret(bs58.encode(kp.secretKey)) },
    update: { mySolanaWallet: address, mySolanaPrivateKey: encryptSecret(bs58.encode(kp.secretKey)) },
  });
  cachedKeypair = kp;
  return address;
}

export async function getSolBalance(address: string): Promise<number | null> {
  const res = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return res ? res.value / LAMPORTS_PER_SOL : null;
}

export async function getTokenBalance(owner: string, mint: string): Promise<{ raw: bigint; decimals: number; ui: number }> {
  const res = await rpc<any>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  let raw = 0n;
  let decimals = 0;
  for (const acc of res?.value || []) {
    const info = acc.account?.data?.parsed?.info?.tokenAmount;
    if (!info) continue;
    raw += BigInt(info.amount);
    decimals = info.decimals;
  }
  return { raw, decimals, ui: Number(raw) / 10 ** decimals };
}

// ─── Prices ────────────────────────────────────────────────────────────────

let solPriceCache = { value: 0, at: 0 };

export async function getSolPriceUsd(): Promise<number> {
  if (solPriceCache.value > 0 && Date.now() - solPriceCache.at < 30000) return solPriceCache.value;

  try {
    const res = await fetch(`${env.JUPITER_API_BASE}/price/v3?ids=${WSOL_MINT}`, {
      headers: jupHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = (await res.json()) as any;
      const p = Number(json?.[WSOL_MINT]?.usdPrice);
      if (p > 0) {
        solPriceCache = { value: p, at: Date.now() };
        return p;
      }
    }
  } catch { /* fall through to DexScreener */ }

  try {
    const res = await fetch(`${env.DEXSCREENER_API_BASE}/latest/dex/tokens/${WSOL_MINT}`, { signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as any;
    const pair = (json.pairs || [])
      .filter((p: any) => p.baseToken?.address === WSOL_MINT && [USDC_MINT, USDT_MINT].includes(p.quoteToken?.address))
      .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const p = Number(pair?.priceUsd);
    if (p > 0) {
      solPriceCache = { value: p, at: Date.now() };
      return p;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'SOL price lookup failed');
  }
  return solPriceCache.value;
}

let idrRateCache = { value: 16000, at: 0 }; // sensible fallback if the FX API is unreachable

export async function getUsdToIdrRate(): Promise<number> {
  if (idrRateCache.at > 0 && Date.now() - idrRateCache.at < 6 * 3600 * 1000) return idrRateCache.value;

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as any;
    const rate = Number(json?.rates?.IDR);
    if (rate > 0) {
      idrRateCache = { value: rate, at: Date.now() };
      return rate;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'USD/IDR rate lookup failed');
  }
  return idrRateCache.value;
}

// ─── Jupiter swaps ─────────────────────────────────────────────────────────

function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.JUPITER_API_KEY) h['x-api-key'] = env.JUPITER_API_KEY;
  return h;
}

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: any;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint | string,
  slippageBps: number
): Promise<JupiterQuote | null> {
  const url =
    `${env.JUPITER_API_BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  try {
    const res = await fetch(url, { headers: jupHeaders(), signal: AbortSignal.timeout(8000) });
    if (res.status === 429) recordApiEvent('jupiter', '429', 'quote');
    if (!res.ok) {
      logger.debug({ status: res.status, inputMint, outputMint }, 'Jupiter quote non-200');
      return null;
    }
    const json = (await res.json()) as any;
    if (!json?.outAmount) return null;
    return json as JupiterQuote;
  } catch (err: any) {
    if (isTimeoutError(err)) recordApiEvent('jupiter', 'timeout', 'quote');
    logger.debug({ err: err?.message }, 'Jupiter quote failed');
    return null;
  }
}

/**
 * Build, sign, send and confirm a swap for a Jupiter quote. Throws on any failure
 * so callers can roll back state — never returns a fake signature.
 */
export async function executeJupiterSwap(quote: JupiterQuote, keypair: Keypair, maxPriorityFeeSol: number): Promise<string> {
  const res = await fetch(`${env.JUPITER_API_BASE}/swap/v1/swap`, {
    method: 'POST',
    headers: jupHeaders(),
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: Math.round(maxPriorityFeeSol * LAMPORTS_PER_SOL),
          priorityLevel: 'veryHigh',
        },
      },
    }),
  });
  if (res.status === 429) recordApiEvent('jupiter', '429', 'swap-build');
  if (!res.ok) throw new Error(`Jupiter swap build failed: HTTP ${res.status} ${await res.text()}`);
  const { swapTransaction, lastValidBlockHeight } = (await res.json()) as any;
  if (!swapTransaction) throw new Error('Jupiter swap build returned no transaction');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const blockhash = tx.message.recentBlockhash;

  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight: lastValidBlockHeight ?? (await connection.getBlockHeight()) + 150 },
      'confirmed'
    );
    if (confirmation.value.err) {
      throw new Error(`Swap ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  } catch (err: any) {
    if (!/block height exceeded|expired/i.test(err?.message || '')) throw err;

    // Local wait for confirmation timed out (blockhash expired) — the tx may have still
    // landed. Poll the signature directly for longer before giving up, so a real fill is
    // never mistaken for a failure and real money never goes untracked.
    logger.warn({ signature }, 'Swap confirmation timed out (blockhash expired) — polling signature status directly');
    recordApiEvent('solana-confirm', 'timeout', signature);
    const outcome = await pollSignatureOutcome(signature);
    if (outcome === 'success') return signature;
    if (outcome === 'failed') throw new Error(`Swap ${signature} failed on-chain after blockhash expiry`);
    throw new Error(`AMBIGUOUS_SWAP ${signature}: status still unknown after blockhash expiry — wallet balance must be checked before retrying`);
  }
}

async function pollSignatureOutcome(signature: string): Promise<'success' | 'failed' | 'unknown'> {
  for (let i = 0; i < 15; i++) {
    const res = await rpc<{ value: Array<{ confirmationStatus?: string; err: any } | null> }>(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }]
    );
    const status = res?.value?.[0];
    if (status) {
      if (status.err) return 'failed';
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return 'success';
    }
    await sleep(3000);
  }
  return 'unknown';
}

// ─── Transaction normalisation (shared by scanner, profiler, executor) ─────

export interface NormalizedTx {
  signature: string;
  timestamp: number; // ms
  failed: boolean;
  solDelta: number; // native SOL + WSOL change for the owner, incl. fee
  stableDelta: number; // USDC/USDT change in USD
  tokenDeltas: Record<string, { delta: number; decimals: number }>; // non-base mints only
}

const BASE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

function uiAmountOf(t: any): number {
  const a = t?.uiTokenAmount;
  if (!a) return 0;
  if (a.uiAmountString !== undefined) return Number(a.uiAmountString);
  return Number(a.uiAmount || 0);
}

/** Normalise a `getTransaction(jsonParsed)` result from the owner's point of view */
export function normalizeRpcTx(tx: any, owner: string, signature: string): NormalizedTx | null {
  if (!tx?.meta) return null;
  const keys: any[] = tx.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k: any) => (typeof k === 'string' ? k : k.pubkey) === owner);

  let solDelta = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL : 0;
  let stableDelta = 0;
  const tokenDeltas: NormalizedTx['tokenDeltas'] = {};

  const byAccount = new Map<number, { mint: string; decimals: number; pre: number; post: number }>();
  for (const t of tx.meta.preTokenBalances || []) {
    if (t.owner !== owner) continue;
    byAccount.set(t.accountIndex, { mint: t.mint, decimals: t.uiTokenAmount?.decimals ?? 0, pre: uiAmountOf(t), post: 0 });
  }
  for (const t of tx.meta.postTokenBalances || []) {
    if (t.owner !== owner) continue;
    const e = byAccount.get(t.accountIndex) || { mint: t.mint, decimals: t.uiTokenAmount?.decimals ?? 0, pre: 0, post: 0 };
    e.post = uiAmountOf(t);
    byAccount.set(t.accountIndex, e);
  }

  for (const { mint, decimals, pre, post } of byAccount.values()) {
    const d = post - pre;
    if (d === 0) continue;
    if (mint === WSOL_MINT) solDelta += d;
    else if (mint === USDC_MINT || mint === USDT_MINT) stableDelta += d;
    else {
      const cur = tokenDeltas[mint] || { delta: 0, decimals };
      cur.delta += d;
      tokenDeltas[mint] = cur;
    }
  }

  return {
    signature,
    timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
    failed: !!tx.meta.err,
    solDelta,
    stableDelta,
    tokenDeltas,
  };
}

/** Normalise a Helius enhanced-transaction item */
export function normalizeHeliusTx(tx: any, owner: string): NormalizedTx {
  let solDelta = 0;
  let stableDelta = 0;
  const tokenDeltas: NormalizedTx['tokenDeltas'] = {};

  for (const acc of tx.accountData || []) {
    if (acc.account === owner) solDelta += (acc.nativeBalanceChange || 0) / LAMPORTS_PER_SOL;
    for (const tb of acc.tokenBalanceChanges || []) {
      if (tb.userAccount !== owner) continue;
      const decimals = tb.rawTokenAmount?.decimals ?? 0;
      const d = Number(tb.rawTokenAmount?.tokenAmount || 0) / 10 ** decimals;
      if (d === 0) continue;
      if (tb.mint === WSOL_MINT) solDelta += d;
      else if (tb.mint === USDC_MINT || tb.mint === USDT_MINT) stableDelta += d;
      else {
        const cur = tokenDeltas[tb.mint] || { delta: 0, decimals };
        cur.delta += d;
        tokenDeltas[tb.mint] = cur;
      }
    }
  }

  return {
    signature: tx.signature,
    timestamp: (tx.timestamp || 0) * 1000,
    failed: !!tx.transactionError,
    solDelta,
    stableDelta,
    tokenDeltas,
  };
}

export async function fetchNormalizedTx(signature: string, owner: string): Promise<NormalizedTx | null> {
  const tx = await rpc<any>('getTransaction', [signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return normalizeRpcTx(tx, owner, signature);
}

/**
 * Recent transactions of a wallet, newest first. Uses Helius enhanced API when a key
 * is configured (1 request for up to 100 parsed txs), otherwise plain RPC.
 */
export async function getRecentWalletTxs(
  owner: string,
  opts: { limit: number; until?: string }
): Promise<{ txs: NormalizedTx[]; newestSignature?: string }> {
  if (env.HELIUS_API_KEY) {
    // Cheap RPC probe first so idle whales don't spend enhanced-API credits every scan
    if (opts.until) {
      const fresh = await rpc<any[]>('getSignaturesForAddress', [owner, { limit: 1, until: opts.until }]);
      if (fresh && fresh.length === 0) return { txs: [] };
    }
    try {
      const url = `https://api.helius.xyz/v0/addresses/${owner}/transactions?api-key=${env.HELIUS_API_KEY}&limit=${Math.min(100, opts.limit)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) recordApiEvent('helius-enhanced', '429', owner);
      if (res.ok) {
        const items = (await res.json()) as any[];
        const out: NormalizedTx[] = [];
        for (const it of items) {
          if (opts.until && it.signature === opts.until) break;
          out.push(normalizeHeliusTx(it, owner));
        }
        return { txs: out, newestSignature: items[0]?.signature };
      }
    } catch (err: any) {
      if (isTimeoutError(err)) recordApiEvent('helius-enhanced', 'timeout', owner);
      logger.debug({ owner, err: err?.message }, 'Helius history fetch failed, falling back to RPC');
    }
  }

  const sigs = await rpc<any[]>('getSignaturesForAddress', [
    owner,
    { limit: opts.limit, ...(opts.until ? { until: opts.until } : {}) },
  ]);
  if (!sigs || sigs.length === 0) return { txs: [] };

  const out: NormalizedTx[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const n = await fetchNormalizedTx(s.signature, owner);
    if (n) out.push(n);
  }
  return { txs: out, newestSignature: sigs[0].signature };
}

export async function getLatestSignature(owner: string): Promise<string | undefined> {
  const sigs = await rpc<any[]>('getSignaturesForAddress', [owner, { limit: 1 }]);
  return sigs?.[0]?.signature;
}

export function isBaseMint(mint: string) {
  return BASE_MINTS.has(mint);
}
