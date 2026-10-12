import { Bot, InlineKeyboard } from 'grammy';
import { env } from '../config/index.js';
import { prisma } from '../db/prisma.js';
import { tradeExecutor } from '../services/executor.js';
import { approvalTimeoutQueue } from '../workers/queue.js';
import { logger } from '../services/logger.js';

export class TelegramBotService {
  private bot: Bot | null = null;
  private isMock = false;

  constructor() {
    if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.startsWith('mock_')) {
      logger.warn('Running with Mock Telegram Bot (no real bot token configured)');
      this.isMock = true;
    } else {
      this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
      this.setupHandlers();
    }
  }

  private setupHandlers() {
    if (!this.bot) return;

    this.bot.command('start', (ctx) => {
      ctx.reply('Whale-Signal Trading Bot active. Waiting for whale signals...');
    });

    this.bot.command('status', async (ctx) => {
      const openCount = await prisma.position.count({ where: { status: 'open' } });
      const signalCount = await prisma.signal.count();
      ctx.reply(`📊 WhaleBot Status:\n- Open Positions: ${openCount}\n- Total Signals: ${signalCount}`);
    });

    // Callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      const chatId = ctx.callbackQuery.message?.chat.id.toString();

      logger.info({ data, messageId, chatId }, 'Telegram callback received');

      if (data.startsWith('approve_buy:')) {
        const signalId = data.split(':')[1];
        await this.handleApproveBuy(ctx, signalId);
      } else if (data.startsWith('skip_buy:')) {
        const signalId = data.split(':')[1];
        await this.handleSkipBuy(ctx, signalId);
      } else if (data.startsWith('tp_sell:')) {
        const positionId = data.split(':')[1];
        await this.handleTakeProfitSell(ctx, positionId);
      } else if (data.startsWith('tp_hold:')) {
        const positionId = data.split(':')[1];
        await this.handleTakeProfitHold(ctx, positionId);
      }

      await ctx.answerCallbackQuery();
    });
  }

  /**
   * Send Buy Signal Alert to Telegram with inline buttons [Approve] [Skip]
   */
  async sendBuyAlert(signalId: string): Promise<number | null> {
    const signal = await prisma.signal.findUnique({
      where: { id: signalId },
      include: { score: true },
    });

    if (!signal || !signal.score) return null;

    const metrics = (signal.rawMetrics as any) || {};
    const breakdown = (signal.score.breakdown as any) || {};
    const chartLink = `https://dexscreener.com/${signal.chain}/${signal.tokenAddress}`;

    const text =
      `🚨 *WHALE BUY SIGNAL DETECTED* 🚨\n\n` +
      `🪙 *Token:* ${signal.tokenName || 'Unknown'} (${signal.tokenSymbol || 'TOKEN'})\n` +
      `📍 *Address:* \`${signal.tokenAddress}\`\n` +
      `⛓️ *Chain:* ${signal.chain.toUpperCase()}\n` +
      `🐋 *Whale Swap:* $${(signal.amountUsd || 0).toLocaleString()}\n\n` +
      `⭐ *Overall Score:* *${signal.score.totalScore}/100*\n` +
      `• Liquidity: ${breakdown.liquidity?.score}/100 (${breakdown.liquidity?.note})\n` +
      `• Top 10 Holders: ${breakdown.holderConcentration?.score}/100 (${breakdown.holderConcentration?.note})\n` +
      `• Contract Safety: ${breakdown.contractSafety?.score}/100 (${breakdown.contractSafety?.note})\n` +
      `• Vol/MC: ${breakdown.volumeMcRatio?.score}/100 (${breakdown.volumeMcRatio?.note})\n` +
      `• Age & Holders: ${breakdown.tokenAgeHolders?.score}/100 (${breakdown.tokenAgeHolders?.note})\n\n` +
      `💧 *Liquidity:* $${(metrics.liquidityUsd || 0).toLocaleString()} (Locked: ${metrics.lockedPercentage || 0}%)\n` +
      `👥 *Top 10:* ${(metrics.top10HoldersPercent || 0).toFixed(1)}%\n` +
      `📈 [View Chart on DexScreener](${chartLink})\n\n` +
      `⏱️ *Approval Timeout:* 2 minutes (default: skip)`;

    const keyboard = new InlineKeyboard()
      .text('✅ Approve Buy', `approve_buy:${signalId}`)
      .text('❌ Skip', `skip_buy:${signalId}`);

    let sentMessageId = Math.floor(Math.random() * 100000);

    if (this.bot && env.TELEGRAM_CHAT_ID) {
      try {
        const msg = await this.bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        sentMessageId = msg.message_id;
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to send Telegram message');
      }
    } else {
      logger.info({ signalId, text }, '[MOCK TELEGRAM] Sent buy alert message');
    }

    // Record interaction in DB
    await prisma.telegramInteraction.create({
      data: {
        signalId,
        messageId: sentMessageId,
        chatId: env.TELEGRAM_CHAT_ID || 'mock_chat',
        alertType: 'buy_approval',
      },
    });

    // Schedule 2-minute BullMQ delayed job for timeout
    await approvalTimeoutQueue.add(
      'buy-timeout',
      { signalId, messageId: sentMessageId },
      { delay: env.APPROVAL_TIMEOUT_SECONDS * 1000 }
    );

    return sentMessageId;
  }

  async handleApproveBuy(ctx: any, signalId: string) {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal || signal.status !== 'pending_approval') {
      await ctx?.reply?.(`Signal is no longer pending (Current status: ${signal?.status || 'unknown'})`);
      return;
    }

    await prisma.signal.update({
      where: { id: signalId },
      data: { status: 'approved' },
    });

    await prisma.telegramInteraction.updateMany({
      where: { signalId, alertType: 'buy_approval' },
      data: { actionTaken: 'approved', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    }

    if (ctx?.reply) {
      await ctx.reply(`✅ *BUY Approved for ${signal.tokenSymbol}*. Executing trade now...`, { parse_mode: 'Markdown' });
    }

    // Execute Buy
    await tradeExecutor.executeBuy(signalId);
  }

  async handleSkipBuy(ctx: any, signalId: string) {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal || signal.status !== 'pending_approval') return;

    await prisma.signal.update({
      where: { id: signalId },
      data: { status: 'skipped' },
    });

    await prisma.telegramInteraction.updateMany({
      where: { signalId, alertType: 'buy_approval' },
      data: { actionTaken: 'skipped', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    }

    if (ctx?.reply) {
      await ctx.reply(`❌ *Skipped signal for ${signal.tokenSymbol}*.`, { parse_mode: 'Markdown' });
    }
  }

  /**
   * Send Take-Profit Alert (+100%) with [Sell] [Hold]
   */
  async sendTakeProfitAlert(positionId: string, currentPnlPercent: number): Promise<number | null> {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'open') return null;

    const text =
      `🎯 *TAKE PROFIT THRESHOLD REACHED* 🎯\n\n` +
      `🪙 *Token:* ${position.tokenSymbol}\n` +
      `📈 *Current PnL:* *+${currentPnlPercent.toFixed(1)}%*\n` +
      `💵 *Entry Price:* $${position.entryPrice}\n` +
      `💲 *Current Price:* $${position.currentPrice}\n\n` +
      `⚠️ *Action required:* Choose *Sell* to secure profit or *Hold* to track higher targets.\n` +
      `⏱️ *Timeout:* 2 minutes (Default safe action: *AUTO SELL*)`;

    const keyboard = new InlineKeyboard()
      .text('💰 Sell (Secure Profit)', `tp_sell:${positionId}`)
      .text('🚀 Hold (Next Target)', `tp_hold:${positionId}`);

    let sentMessageId = Math.floor(Math.random() * 100000);

    if (this.bot && env.TELEGRAM_CHAT_ID) {
      try {
        const msg = await this.bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        sentMessageId = msg.message_id;
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to send take-profit alert');
      }
    } else {
      logger.info({ positionId, currentPnlPercent }, '[MOCK TELEGRAM] Sent take-profit alert');
    }

    await prisma.telegramInteraction.create({
      data: {
        positionId,
        messageId: sentMessageId,
        chatId: env.TELEGRAM_CHAT_ID || 'mock_chat',
        alertType: 'take_profit_approval',
      },
    });

    // Schedule 2-minute delayed job for Take Profit Auto-Sell on Timeout
    await approvalTimeoutQueue.add(
      'take-profit-timeout',
      { positionId, messageId: sentMessageId },
      { delay: env.APPROVAL_TIMEOUT_SECONDS * 1000 }
    );

    return sentMessageId;
  }

  async handleTakeProfitSell(ctx: any, positionId: string) {
    await prisma.telegramInteraction.updateMany({
      where: { positionId, alertType: 'take_profit_approval' },
      data: { actionTaken: 'sell', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    }

    if (ctx?.reply) {
      await ctx.reply(`💰 Selling position now to lock in profit...`);
    }

    await tradeExecutor.executeSell(positionId, 'take_profit_approved');
  }

  async handleTakeProfitHold(ctx: any, positionId: string) {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'open') return;

    // Advance next take profit threshold by step (e.g. +50%)
    const nextTp = position.nextTpThreshold + env.TAKE_PROFIT_STEP;

    await prisma.position.update({
      where: { id: positionId },
      data: { nextTpThreshold: nextTp },
    });

    await prisma.telegramInteraction.updateMany({
      where: { positionId, alertType: 'take_profit_approval' },
      data: { actionTaken: 'hold', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    }

    if (ctx?.reply) {
      await ctx.reply(`🚀 Position kept open! Next alert will trigger at +${nextTp}% PnL.`);
    }

    logger.info({ positionId, nextTp }, 'User selected HOLD, TP threshold increased');
  }

  /**
   * Send Stop-Loss Notification (sent AFTER automatic execution)
   */
  async sendStopLossAlert(positionId: string, exitPrice: number, pnlPercent: number) {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position) return;

    const text =
      `🛑 *AUTO STOP-LOSS EXECUTED* 🛑\n\n` +
      `🪙 *Token:* ${position.tokenSymbol}\n` +
      `📉 *Loss:* *${pnlPercent.toFixed(1)}%*\n` +
      `💵 *Entry Price:* $${position.entryPrice}\n` +
      `🔻 *Exit Price:* $${exitPrice}\n\n` +
      `*Position has been closed automatically to protect capital.*`;

    if (this.bot && env.TELEGRAM_CHAT_ID) {
      try {
        await this.bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' });
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to send stop loss alert');
      }
    } else {
      logger.info({ positionId, pnlPercent }, '[MOCK TELEGRAM] Sent stop loss notification');
    }
  }

  start() {
    if (this.bot) {
      this.bot.start({
        onStart: (botInfo) => {
          logger.info({ username: botInfo.username }, 'Telegram bot started');
        },
      });
    }
  }
}

export const telegramBot = new TelegramBotService();
