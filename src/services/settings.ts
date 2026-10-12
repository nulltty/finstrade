import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { logger } from './logger.js';

export interface BotSettingsData {
  paperTrading: boolean;
  chain: string;
  tradeAmountUsd: number;
  maxOpenPositions: number;
  maxDailySpendUsd: number;
  slippageBps: number;
  maxPriorityFee: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  takeProfitStep: number;
  approvalTimeoutSec: number;
  buyTimeoutAction: string;
  scoringThreshold: number;
  minLiquidityUsd: number;
  hardFailMinLiquidity: number;
  autoScanIntervalSec: number;
  autoDiscoveryEnabled: boolean;
  autoDiscoveryIntervalMin: number;
  mySolanaWallet?: string | null;
  mySolanaPrivateKey?: string | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
}

export class SettingsService {
  private cachedSettings: BotSettingsData | null = null;
  private lastFetchTime = 0;

  async getSettings(): Promise<BotSettingsData> {
    const now = Date.now();
    if (this.cachedSettings && now - this.lastFetchTime < 10000) {
      return this.cachedSettings;
    }

    let record = await prisma.botSetting.findUnique({ where: { id: 'default' } });

    if (!record) {
      // Initialize default settings from env
      record = await prisma.botSetting.create({
        data: {
          id: 'default',
          paperTrading: env.PAPER_TRADING,
          chain: env.CHAIN,
          tradeAmountUsd: env.TRADE_AMOUNT_USD,
          maxOpenPositions: 5,
          maxDailySpendUsd: 200,
          slippageBps: env.SLIPPAGE_BPS,
          maxPriorityFee: env.MAX_PRIORITY_FEE,
          stopLossPercent: env.STOP_LOSS_PERCENT,
          takeProfitPercent: env.TAKE_PROFIT_PERCENT,
          takeProfitStep: env.TAKE_PROFIT_STEP,
          approvalTimeoutSec: env.APPROVAL_TIMEOUT_SECONDS,
          buyTimeoutAction: env.BUY_TIMEOUT_ACTION,
          scoringThreshold: env.SCORING_THRESHOLD,
          minLiquidityUsd: env.MIN_LIQUIDITY_USD,
          hardFailMinLiquidity: env.HARD_FAIL_MIN_LIQUIDITY_USD,
          autoScanIntervalSec: 20,
          autoDiscoveryEnabled: true,
          autoDiscoveryIntervalMin: 60,
          mySolanaWallet: '',
          mySolanaPrivateKey: env.SOLANA_PRIVATE_KEY || '',
          telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
          telegramChatId: env.TELEGRAM_CHAT_ID || '',
        },
      });
      logger.info('Initialized default bot settings in database');
    }

    this.cachedSettings = {
      paperTrading: record.paperTrading,
      chain: record.chain,
      tradeAmountUsd: record.tradeAmountUsd,
      maxOpenPositions: record.maxOpenPositions,
      maxDailySpendUsd: record.maxDailySpendUsd,
      slippageBps: record.slippageBps,
      maxPriorityFee: record.maxPriorityFee,
      stopLossPercent: record.stopLossPercent,
      takeProfitPercent: record.takeProfitPercent,
      takeProfitStep: record.takeProfitStep,
      approvalTimeoutSec: record.approvalTimeoutSec,
      buyTimeoutAction: record.buyTimeoutAction,
      scoringThreshold: record.scoringThreshold,
      minLiquidityUsd: record.minLiquidityUsd,
      hardFailMinLiquidity: record.hardFailMinLiquidity,
      autoScanIntervalSec: record.autoScanIntervalSec,
      autoDiscoveryEnabled: record.autoDiscoveryEnabled,
      autoDiscoveryIntervalMin: record.autoDiscoveryIntervalMin,
      mySolanaWallet: record.mySolanaWallet,
      mySolanaPrivateKey: record.mySolanaPrivateKey,
      telegramBotToken: record.telegramBotToken,
      telegramChatId: record.telegramChatId,
    };
    this.lastFetchTime = now;

    return this.cachedSettings;
  }

  async updateSettings(updates: Partial<BotSettingsData>): Promise<BotSettingsData> {
    const updated = await prisma.botSetting.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        ...updates,
      },
      update: updates,
    });

    this.cachedSettings = null; // Invalidate cache
    logger.info({ updates }, 'Bot settings updated successfully');

    return this.getSettings();
  }
}

export const settingsService = new SettingsService();
