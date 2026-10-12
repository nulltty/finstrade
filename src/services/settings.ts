import type { BotSetting } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { logger } from './logger.js';

export type BotSettingsData = Omit<BotSetting, 'id' | 'updatedAt'>;

// Fields that must never be written through the generic settings API
const PROTECTED_FIELDS = new Set(['id', 'updatedAt', 'mySolanaWallet', 'mySolanaPrivateKey']);

export class SettingsService {
  private cachedSettings: BotSettingsData | null = null;
  private lastFetchTime = 0;
  private listeners: Array<(s: BotSettingsData) => void> = [];

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
          telegramBotToken: env.TELEGRAM_BOT_TOKEN.startsWith('mock_') ? '' : env.TELEGRAM_BOT_TOKEN,
          telegramChatId: env.TELEGRAM_CHAT_ID || '',
        },
      });
      logger.info('Initialized default bot settings in database');
    }

    const { id: _id, updatedAt: _u, ...data } = record;
    this.cachedSettings = data;
    this.lastFetchTime = now;
    return this.cachedSettings;
  }

  async updateSettings(updates: Partial<BotSettingsData>): Promise<BotSettingsData> {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (!PROTECTED_FIELDS.has(k) && v !== undefined) clean[k] = v;
    }

    await prisma.botSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...clean },
      update: clean,
    });

    this.cachedSettings = null; // Invalidate cache
    logger.info({ updates: Object.keys(clean) }, 'Bot settings updated successfully');

    const fresh = await this.getSettings();
    for (const l of this.listeners) {
      try {
        l(fresh);
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Settings listener failed');
      }
    }
    return fresh;
  }

  onChange(listener: (s: BotSettingsData) => void) {
    this.listeners.push(listener);
  }

  /** Settings safe to send to the browser (no secrets) */
  async getPublicSettings() {
    const { mySolanaPrivateKey, telegramBotToken, ...rest } = await this.getSettings();
    return {
      ...rest,
      hasTradingKey: !!mySolanaPrivateKey || !!env.SOLANA_PRIVATE_KEY,
      telegramBotToken: telegramBotToken ? `${telegramBotToken.slice(0, 6)}...${telegramBotToken.slice(-4)}` : '',
    };
  }
}

export const settingsService = new SettingsService();
