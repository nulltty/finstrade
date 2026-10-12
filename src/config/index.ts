import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  WEBHOOK_SECRET: z.string().default('super_secret_webhook_key_12345'),

  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/whalebot?schema=public'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  TELEGRAM_BOT_TOKEN: z.string().default('mock_token'),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_ADMIN_IDS: z.string().default(''),

  HELIUS_API_KEY: z.string().optional().default(''),
  ALCHEMY_API_KEY: z.string().optional().default(''),
  WATCHED_WALLETS: z.string().default(''),

  GOPLUS_API_BASE: z.string().default('https://api.gopluslabs.io'),
  DEXSCREENER_API_BASE: z.string().default('https://api.dexscreener.com'),
  BIRDEYE_API_KEY: z.string().optional().default(''),

  PAPER_TRADING: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  CHAIN: z.enum(['solana', 'evm']).default('solana'),
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  SOLANA_PRIVATE_KEY: z.string().optional().default(''),
  EVM_RPC_URL: z.string().optional().default(''),
  EVM_PRIVATE_KEY: z.string().optional().default(''),

  TRADE_AMOUNT_USD: z.coerce.number().default(10),
  SLIPPAGE_BPS: z.coerce.number().default(500), // 5%
  MAX_PRIORITY_FEE: z.coerce.number().default(0.001),
  STOP_LOSS_PERCENT: z.coerce.number().default(20), // 20%
  TAKE_PROFIT_PERCENT: z.coerce.number().default(100), // 100%
  TAKE_PROFIT_STEP: z.coerce.number().default(50), // 50%
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().default(120), // 2 minutes
  BUY_TIMEOUT_ACTION: z.enum(['skip', 'auto_buy']).default('skip'),

  SCORING_THRESHOLD: z.coerce.number().default(80),
  MIN_LIQUIDITY_USD: z.coerce.number().default(10000),
  HARD_FAIL_MIN_LIQUIDITY_USD: z.coerce.number().default(5000),

  MAX_CONSECUTIVE_STOP_LOSS: z.coerce.number().default(3),
  CIRCUIT_BREAKER_WINDOW_MINUTES: z.coerce.number().default(60),
});

export const env = envSchema.parse(process.env);

export const scoringWeights = {
  liquidity: 0.25,
  holderConcentration: 0.20,
  contractSafety: 0.25,
  volumeMcRatio: 0.15,
  tokenAgeHolders: 0.15,
};

export const blueChipTokens = new Set([
  'SOL', 'WSOL', 'ETH', 'WETH', 'BTC', 'WBTC', 'USDC', 'USDT', 'DAI', 'BNB',
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC Solana
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT Solana
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH EVM
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC EVM
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT EVM
]);
