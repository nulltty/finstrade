import { Bot, InlineKeyboard } from 'grammy';
import { env } from '../config/index.js';
import { prisma } from '../db/prisma.js';
import { tradeExecutor } from '../services/executor.js';
import { approvalTimeoutQueue } from '../workers/queue.js';
import { settingsService } from '../services/settings.js';
import { logger } from '../services/logger.js';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n: number | null | undefined) =>
  `$${(n || 0).toLocaleString('en-US', { maximumFractionDigits: (n || 0) < 1 ? 8 : 2 })}`;
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

const REASON_LABEL: Record<string, string> = {
  stop_loss: '🛑 Stop-loss',
  trailing_stop: '📉 Trailing stop',
  take_profit_auto: '🎯 Take-profit (auto)',
  take_profit_approved: '💰 Take-profit (approved)',
  take_profit_timeout: '⏱️ Take-profit (timeout auto-sell)',
  whale_exit: '🐋 Whale exited — copy-sell',
  manual: '✋ Manual close',
};

export class TelegramBotService {
  private bot: Bot | null = null;
  private chatId = '';
  private activeToken = '';

  /** (Re)connect using the token/chat from dashboard settings, falling back to env */
  async init() {
    const settings = await settingsService.getSettings();
    const valid = (t?: string | null) => (t && /^\d+:[\w-]{20,}$/.test(t.trim()) ? t.trim() : '');
    const token = valid(settings.telegramBotToken) || valid(env.TELEGRAM_BOT_TOKEN);
    this.chatId = [settings.telegramChatId, env.TELEGRAM_CHAT_ID].find((c) => c && /^-?\d+$|^@\w+$/.test(c.trim()))?.trim() || '';

    if (token === this.activeToken && this.bot) return;
    await this.stop();

    if (!token) {
      logger.warn('Telegram not configured — notifications are logged only');
      return;
    }

    this.bot = new Bot(token);
    this.activeToken = token;
    this.setupHandlers();
    this.bot.start({
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'Telegram bot started'),
    }).catch((err) => {
      logger.error({ err: err?.message }, 'Telegram polling stopped');
    });
  }

  async stop() {
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch { /* not started */ }
    }
    this.bot = null;
    this.activeToken = '';
  }

  private isAdmin(userId?: number) {
    const admins = env.TELEGRAM_ADMIN_IDS.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    return admins.length === 0 || (userId !== undefined && admins.includes(String(userId)));
  }

  private setupHandlers() {
    if (!this.bot) return;

    this.bot.command('start', (ctx) => ctx.reply('🐟 Fins Trade aktif 24/7. Memantau whale wallet...'));

    this.bot.command('status', async (ctx) => {
      const [openCount, signalCount, whales] = await Promise.all([
        prisma.position.count({ where: { status: 'open' } }),
        prisma.signal.count(),
        prisma.watchedWallet.count({ where: { isActive: true } }),
      ]);
      const s = await settingsService.getSettings();
      await ctx.reply(
        `📊 <b>Fins Trade Status</b>\n` +
          `Mode: ${s.paperTrading ? 'PAPER' : '🔴 LIVE'} · ${s.autoTradeMode ? 'AUTO' : 'APPROVAL'}\n` +
          `Whales aktif: ${whales}\nPosisi terbuka: ${openCount}\nTotal sinyal: ${signalCount}`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.on('callback_query:data', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) {
        await ctx.answerCallbackQuery({ text: 'Not authorised' });
        return;
      }
      const data = ctx.callbackQuery.data;
      logger.info({ data, from: ctx.from?.id }, 'Telegram callback received');

      const [action, id] = data.split(':');
      if (action === 'approve_buy') await this.handleApproveBuy(ctx, id);
      else if (action === 'skip_buy') await this.handleSkipBuy(ctx, id);
      else if (action === 'tp_sell') await this.handleTakeProfitSell(ctx, id);
      else if (action === 'tp_hold') await this.handleTakeProfitHold(ctx, id);

      await ctx.answerCallbackQuery();
    });
  }

  /** Send a message; returns its id, or null when Telegram isn't configured / fails */
  async notify(text: string, keyboard?: InlineKeyboard): Promise<number | null> {
    if (!this.bot || !this.chatId) {
      logger.info({ text: text.replace(/<[^>]+>/g, '').slice(0, 300) }, '[TELEGRAM not configured] notification');
      return null;
    }
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      return msg.message_id;
    } catch (err: any) {
      logger.error({ err: err?.message }, 'Failed to send Telegram message');
      return null;
    }
  }

  private async signalSummary(signalId: string) {
    const signal = await prisma.signal.findUnique({ where: { id: signalId }, include: { score: true } });
    if (!signal || !signal.score) return null;
    const m = (signal.rawMetrics as any) || {};
    const b = (signal.score.breakdown as any) || {};
    const whale = await prisma.watchedWallet.findUnique({ where: { address: signal.wallet } });

    const text =
      `🪙 <b>${esc(signal.tokenName)}</b> ($${esc(signal.tokenSymbol)})\n` +
      `<code>${esc(signal.tokenAddress)}</code>\n` +
      `🐋 Whale <code>${esc(signal.wallet.slice(0, 6))}…${esc(signal.wallet.slice(-4))}</code>` +
      (whale?.winRate ? ` · WR ${whale.winRate.toFixed(0)}% · PnL ${whale.realizedPnlSol.toFixed(1)} SOL` : '') +
      `\n💸 Whale buy: ${usd(signal.amountUsd)}\n\n` +
      `⭐ <b>Score ${signal.score.totalScore}/100</b>\n` +
      `• Liquidity ${b.liquidity?.score}/100 — ${esc(b.liquidity?.note)}\n` +
      `• Top10 ${b.holderConcentration?.score}/100 — ${esc(b.holderConcentration?.note)}\n` +
      `• Contract ${b.contractSafety?.score}/100 — ${esc(b.contractSafety?.note)}\n` +
      `• Vol/MC ${b.volumeMcRatio?.score}/100 — ${esc(b.volumeMcRatio?.note)}\n` +
      `• Age/Holders ${b.tokenAgeHolders?.score}/100 — ${esc(b.tokenAgeHolders?.note)}\n\n` +
      `💧 Liq ${usd(m.liquidityUsd)} (LP locked ${m.lockedPercentage ?? 0}%) · MC ${usd(m.marketCap)}\n` +
      `🛡️ Sell route: ${m.sellRouteOk === true ? '✅' : m.sellRouteOk === false ? '❌' : '?'}` +
      (m.roundTripLossPct != null ? ` · round-trip −${Number(m.roundTripLossPct).toFixed(1)}%` : '') +
      ` · Mint ${m.hasMintFunction ? '⚠️' : '✅'} · Freeze ${m.hasFreezeAuthority ? '⚠️' : '✅'}\n` +
      `📈 <a href="https://dexscreener.com/${esc(signal.chain)}/${esc(signal.tokenAddress)}">DexScreener</a> · ` +
      `<a href="https://rugcheck.xyz/tokens/${esc(signal.tokenAddress)}">RugCheck</a>`;
    return { signal, text };
  }

  /**
   * Send Buy Signal Alert to Telegram with inline buttons [Approve] [Skip]
   */
  async sendBuyAlert(signalId: string): Promise<number | null> {
    const summary = await this.signalSummary(signalId);
    if (!summary) return null;
    const settings = await settingsService.getSettings();

    const keyboard = new InlineKeyboard()
      .text('✅ Approve Buy', `approve_buy:${signalId}`)
      .text('❌ Skip', `skip_buy:${signalId}`);

    const text =
      `🚨 <b>WHALE BUY SIGNAL — APPROVAL NEEDED</b>\n\n${summary.text}\n\n` +
      `⏱️ Timeout ${Math.round(settings.approvalTimeoutSec / 60)} menit (default: ${settings.buyTimeoutAction === 'auto_buy' ? 'auto-buy' : 'skip'})`;
    const sentMessageId = await this.notify(text, keyboard);

    await prisma.telegramInteraction.create({
      data: {
        signalId,
        messageId: sentMessageId ?? 0,
        chatId: this.chatId || 'unconfigured',
        alertType: 'buy_approval',
      },
    });

    await approvalTimeoutQueue.add(
      'buy-timeout',
      { signalId, messageId: sentMessageId },
      { delay: settings.approvalTimeoutSec * 1000 }
    );

    return sentMessageId;
  }

  /** Auto mode: signal passed every safety check and the bot bought (or tried to) */
  async sendAutoBuyNotice(signalId: string, result: { success: boolean; isPaper?: boolean; amountUsd?: number; txHash?: string; error?: string }) {
    const summary = await this.signalSummary(signalId);
    if (!summary) return;
    const header = result.success
      ? `✅ <b>AUTO BUY ${result.isPaper ? '(PAPER)' : '🔴 LIVE'}</b> — ${usd(result.amountUsd)}`
      : `⚠️ <b>SAFETY PASSED — BUY NOT EXECUTED</b>\nAlasan: ${esc(result.error)}`;
    const tx = result.success && result.txHash && !result.isPaper ? `\n🔗 <a href="https://solscan.io/tx/${esc(result.txHash)}">Solscan</a>` : '';
    await this.notify(`${header}\n\n${summary.text}${tx}`);
  }

  async handleApproveBuy(ctx: any, signalId: string) {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal || signal.status !== 'pending_approval') {
      await ctx?.reply?.(`Signal is no longer pending (Current status: ${signal?.status || 'unknown'})`);
      return;
    }

    await prisma.signal.update({ where: { id: signalId }, data: { status: 'approved' } });
    await prisma.telegramInteraction.updateMany({
      where: { signalId, alertType: 'buy_approval', actionTaken: null },
      data: { actionTaken: 'approved', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    if (ctx?.reply) await ctx.reply(`✅ BUY approved for ${signal.tokenSymbol}. Executing...`);

    const result = await tradeExecutor.executeBuy(signalId);
    if (ctx?.reply) {
      await ctx.reply(result.success ? `✅ Filled ${signal.tokenSymbol} (${usd(result.amountUsd)})` : `❌ Buy failed: ${result.error}`);
    }
  }

  async handleSkipBuy(ctx: any, signalId: string) {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal || signal.status !== 'pending_approval') return;

    await prisma.signal.update({ where: { id: signalId }, data: { status: 'skipped' } });
    await prisma.telegramInteraction.updateMany({
      where: { signalId, alertType: 'buy_approval', actionTaken: null },
      data: { actionTaken: 'skipped', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    if (ctx?.reply) await ctx.reply(`❌ Skipped ${signal.tokenSymbol}.`);
  }

  /**
   * Send Take-Profit Alert with [Sell] [Hold] (approval mode only)
   */
  async sendTakeProfitAlert(positionId: string, currentPnlPercent: number): Promise<number | null> {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'open') return null;
    const settings = await settingsService.getSettings();

    const text =
      `🎯 <b>TAKE PROFIT REACHED</b>\n\n` +
      `🪙 ${esc(position.tokenSymbol)} · PnL <b>${pct(currentPnlPercent)}</b>\n` +
      `Entry ${usd(position.entryPrice)} → Now ${usd(position.currentPrice)}\n\n` +
      `Pilih <b>Sell</b> untuk amankan profit atau <b>Hold</b> untuk target berikutnya (+${settings.takeProfitStep}%).\n` +
      `⏱️ Timeout ${Math.round(settings.approvalTimeoutSec / 60)} menit → <b>AUTO SELL</b>`;

    const keyboard = new InlineKeyboard()
      .text('💰 Sell', `tp_sell:${positionId}`)
      .text('🚀 Hold', `tp_hold:${positionId}`);
    const sentMessageId = await this.notify(text, keyboard);

    await prisma.telegramInteraction.create({
      data: {
        positionId,
        messageId: sentMessageId ?? 0,
        chatId: this.chatId || 'unconfigured',
        alertType: 'take_profit_approval',
      },
    });

    await approvalTimeoutQueue.add(
      'take-profit-timeout',
      { positionId, messageId: sentMessageId },
      { delay: settings.approvalTimeoutSec * 1000 }
    );

    return sentMessageId;
  }

  async handleTakeProfitSell(ctx: any, positionId: string) {
    await prisma.telegramInteraction.updateMany({
      where: { positionId, alertType: 'take_profit_approval', actionTaken: null },
      data: { actionTaken: 'sell', respondedAt: new Date() },
    });
    if (ctx?.editMessageReplyMarkup) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    if (ctx?.reply) await ctx.reply('💰 Selling position now to lock in profit...');
    await tradeExecutor.executeSell(positionId, 'take_profit_approved');
  }

  async handleTakeProfitHold(ctx: any, positionId: string) {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'open') return;
    const settings = await settingsService.getSettings();

    const nextTp = position.nextTpThreshold + settings.takeProfitStep;
    await prisma.position.update({ where: { id: positionId }, data: { nextTpThreshold: nextTp } });
    await prisma.telegramInteraction.updateMany({
      where: { positionId, alertType: 'take_profit_approval', actionTaken: null },
      data: { actionTaken: 'hold', respondedAt: new Date() },
    });

    if (ctx?.editMessageReplyMarkup) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    if (ctx?.reply) await ctx.reply(`🚀 Holding. Next alert at +${nextTp}% PnL.`);
    logger.info({ positionId, nextTp }, 'User selected HOLD, TP threshold increased');
  }

  /**
   * Send Stop-Loss Notification (sent AFTER automatic execution)
   */
  async sendStopLossAlert(positionId: string, exitPrice: number, pnlPercent: number) {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position) return;
    await this.notify(
      `🛑 <b>AUTO STOP-LOSS EXECUTED</b>\n\n` +
        `🪙 ${esc(position.tokenSymbol)} · <b>${pct(pnlPercent)}</b>\n` +
        `Entry ${usd(position.entryPrice)} → Exit ${usd(exitPrice)}\n` +
        `Posisi ditutup otomatis untuk melindungi modal.`
    );
  }

  /** Every non-stop-loss close (stop-loss has its own message above) */
  async sendSellNotice(positionId: string, reason: string, pnlPercent: number, pnlUsd: number, txHash: string) {
    if (reason === 'stop_loss') return;
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position) return;
    const tx = position.isPaper ? ' (paper)' : `\n🔗 <a href="https://solscan.io/tx/${esc(txHash)}">Solscan</a>`;
    await this.notify(
      `${REASON_LABEL[reason] || reason} — <b>${esc(position.tokenSymbol)}</b>\n` +
        `PnL <b>${pct(pnlPercent)}</b> (${pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(pnlUsd))})${tx}`
    );
  }

  async sendTrailingArmedNotice(positionId: string, pnlPercent: number, trailPct: number) {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position) return;
    await this.notify(
      `🎯 <b>${esc(position.tokenSymbol)} ${pct(pnlPercent)}</b> — take-profit tercapai.\n` +
        `Trailing stop ${trailPct}% aktif: bot akan jual otomatis kalau harga turun ${trailPct}% dari puncak.`
    );
  }

  start() {
    this.init().catch((err) => logger.error({ err: err?.message }, 'Telegram init failed'));
  }
}

export const telegramBot = new TelegramBotService();
