import express from 'express';
import cors from 'cors';
import { prisma } from '../db/prisma.js';
import { whaleWatcherService } from '../services/watcher.js';
import { whaleDiscovery } from '../services/discovery.js';
import { multiWalletScanner } from '../services/scanner.js';
import { circuitBreaker } from '../services/circuitBreaker.js';
import { tradeExecutor } from '../services/executor.js';
import { telegramBot } from '../bot/telegram.js';
import { settingsService } from '../services/settings.js';
import { env } from '../config/index.js';
import { logger } from '../services/logger.js';

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', async (req, res) => {
    const settings = await settingsService.getSettings();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      paperTrading: settings.paperTrading,
      tradeAmountUsd: settings.tradeAmountUsd,
    });
  });

  // 1. Settings APIs
  app.get('/api/settings', async (req, res) => {
    try {
      const settings = await settingsService.getSettings();
      // Mask private key in response
      const masked = {
        ...settings,
        mySolanaPrivateKey: settings.mySolanaPrivateKey
          ? settings.mySolanaPrivateKey.substring(0, 4) + '...' + settings.mySolanaPrivateKey.substring(settings.mySolanaPrivateKey.length - 4)
          : '',
      };
      res.json(masked);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const updates = req.body;
      // If private key wasn't changed or is masked, don't overwrite with dots
      if (updates.mySolanaPrivateKey && updates.mySolanaPrivateKey.includes('...')) {
        delete updates.mySolanaPrivateKey;
      }
      const updated = await settingsService.updateSettings(updates);
      res.json({ success: true, settings: updated });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/settings/test-telegram', async (req, res) => {
    try {
      const settings = await settingsService.getSettings();
      const botToken = req.body.telegramBotToken || settings.telegramBotToken;
      const chatId = req.body.telegramChatId || settings.telegramChatId;

      if (!botToken || !chatId) {
        return res.status(400).json({ error: 'Telegram Bot Token and Chat ID are required' });
      }

      const testMsg = `🤖 *WhaleBot 24/7 Notification Test*\n\n✅ Koneksi Telegram berhasil!\nBot aktif memantau sinyal whale dan meme coins 24/7.`;
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const tgRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: testMsg, parse_mode: 'Markdown' }),
      });

      const json = await tgRes.json() as any;
      if (!json.ok) {
        return res.status(400).json({ error: json.description || 'Telegram API error' });
      }

      res.json({ success: true, message: 'Telegram test message sent successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // 2. Webhooks
  app.post('/api/webhook/helius', async (req, res) => {
    try {
      const payload = req.body;
      logger.info({ count: Array.isArray(payload) ? payload.length : 1 }, 'Helius webhook received');
      const events = whaleWatcherService.parseHeliusWebhook(Array.isArray(payload) ? payload : [payload]);

      for (const event of events) {
        await whaleWatcherService.processEvent(event);
      }

      res.json({ success: true, processed: events.length });
    } catch (err: any) {
      logger.error({ err: err?.message }, 'Error in Helius webhook');
      res.status(500).json({ error: err?.message });
    }
  });

  // 3. Whale Wallets Management APIs
  app.get('/api/wallets', async (req, res) => {
    try {
      const wallets = await prisma.watchedWallet.findMany({
        orderBy: { createdAt: 'desc' },
      });
      res.json(wallets);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/wallets', async (req, res) => {
    try {
      const { address, chain = 'solana', label, tags } = req.body;
      if (!address) {
        return res.status(400).json({ error: 'Address is required' });
      }
      const wallet = await whaleDiscovery.addWallet({ address, chain, label, tags });
      res.json({ success: true, wallet });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/wallets/:id/toggle', async (req, res) => {
    try {
      const wallet = await whaleDiscovery.toggleWallet(req.params.id);
      res.json({ success: true, wallet });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.delete('/api/wallets/:id', async (req, res) => {
    try {
      await whaleDiscovery.deleteWallet(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/wallets/auto-discover', async (req, res) => {
    try {
      const result = await whaleDiscovery.autoDiscoverWhalesFromTrending();
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/wallets/scan-now', async (req, res) => {
    try {
      const result = await multiWalletScanner.scanAllActiveWallets();
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // 4. Signals, Positions & Trades APIs
  app.get('/api/signals', async (req, res) => {
    const signals = await prisma.signal.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { score: true },
    });
    res.json(signals);
  });

  app.get('/api/positions', async (req, res) => {
    const positions = await prisma.position.findMany({
      orderBy: { openedAt: 'desc' },
      take: 50,
      include: { trades: true },
    });
    res.json(positions);
  });

  app.get('/api/trades', async (req, res) => {
    const trades = await prisma.trade.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(trades);
  });

  app.get('/api/circuit-breaker', (req, res) => {
    res.json(circuitBreaker.getStatus());
  });

  app.post('/api/circuit-breaker/reset', (req, res) => {
    circuitBreaker.reset();
    res.json({ success: true, status: circuitBreaker.getStatus() });
  });

  app.post('/api/positions/:id/close', async (req, res) => {
    try {
      const result = await tradeExecutor.executeSell(req.params.id, 'manual');
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/signals/:id/approve', async (req, res) => {
    try {
      await telegramBot.handleApproveBuy(null, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/signals/:id/skip', async (req, res) => {
    try {
      await telegramBot.handleSkipBuy(null, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Simulation endpoint
  app.post('/api/simulate-signal', async (req, res) => {
    try {
      const {
        wallet = 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
        chain = 'solana',
        tokenAddress = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        tokenSymbol = 'BONK',
        tokenName = 'Bonk Coin',
        amountUsd = 25000,
      } = req.body;

      const txHash = `sim_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const result = await whaleWatcherService.processEvent({
        wallet,
        chain,
        tokenAddress,
        tokenSymbol,
        tokenName,
        txHash,
        amountUsd,
      });

      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // 5. Web UI Dashboard
  app.get('/', (req, res) => {
    res.send(getDashboardHtml());
  });

  return app;
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Whale-Signal Meme Coin 24/7 Autonomous Bot Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-hover: #1f293d;
      --border: #1f2937;
      --border-accent: #374151;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --purple: #8b5cf6;
      --cyan: #06b6d4;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
      gap: 16px;
    }
    h1 { font-size: 1.5rem; font-weight: 800; display: flex; align-items: center; gap: 10px; }
    .pulse-dot {
      width: 10px;
      height: 10px;
      background: var(--success);
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 10px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }
    .badge {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-paper { background: #1e293b; color: #60a5fa; border: 1px solid #3b82f6; }
    .badge-live { background: #064e3b; color: #34d399; border: 1px solid #10b981; }
    .badge-open { background: #064e3b; color: #34d399; }
    .badge-closed { background: #374151; color: #9ca3af; }
    .badge-tag { background: #1e1b4b; color: #c7d2fe; border: 1px solid #4338ca; margin-right: 4px; }
    
    /* Navigation Tabs */
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      overflow-x: auto;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .tab-btn:hover { color: var(--text); background: var(--card-bg); }
    .tab-btn.active {
      background: var(--card-bg);
      color: var(--primary);
      border-color: var(--border-accent);
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    /* Grid & Cards */
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      transition: border-color 0.2s;
    }
    .card:hover { border-color: var(--border-accent); }
    .card-title { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
    .card-value { font-size: 1.75rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    
    /* Tables */
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
      overflow-x: auto;
    }
    h2 { font-size: 1.15rem; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 0.78rem; text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:hover td { background: rgba(255,255,255,0.015); }
    .pnl-positive { color: var(--success); font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    .pnl-negative { color: var(--danger); font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    
    /* Buttons */
    .btn {
      padding: 8px 14px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.85rem;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }
    .btn-primary { background: var(--primary); color: white; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-success { background: var(--success); color: white; }
    .btn-purple { background: var(--purple); color: white; }
    .btn-secondary { background: #374151; color: white; }

    /* Form & Settings */
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
    }
    .form-group {
      margin-bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    label { font-size: 0.85rem; font-weight: 600; color: #d1d5db; }
    .hint { font-size: 0.75rem; color: var(--text-muted); }
    input, select {
      background: #0b0f19;
      border: 1px solid #334155;
      padding: 10px 14px;
      border-radius: 8px;
      color: white;
      font-family: inherit;
      font-size: 0.9rem;
      width: 100%;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1e1b4b;
      border: 1px solid var(--purple);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 999;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div id="toast" class="toast">Settings Saved Successfully!</div>

  <header>
    <div>
      <h1>🐋 Whale-Signal Meme Coin Bot <span class="pulse-dot"></span></h1>
      <small style="color:var(--text-muted);">Autonomous 24/7 On-Chain Engine Active</small>
    </div>
    <div style="display:flex; align-items:center; gap:10px;">
      <span id="badgeTradingMode" class="badge badge-paper">Mode: Paper Trading</span>
      <button class="btn btn-primary" onclick="loadData()">🔄 Refresh</button>
    </div>
  </header>

  <!-- Navigation Tabs -->
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('overview')">📊 Overview & Sinyal</button>
    <button class="tab-btn" onclick="switchTab('settings')">⚙️ Menu Setting & Wallet</button>
    <button class="tab-btn" onclick="switchTab('wallets')">🐋 Whale Watchlist</button>
    <button class="tab-btn" onclick="switchTab('positions')">📈 Posisi & Riwayat Trade</button>
  </div>

  <!-- TAB 1: OVERVIEW -->
  <div id="tab-overview">
    <div class="grid">
      <div class="card">
        <div class="card-title">Max Purchase / Coin</div>
        <div class="card-value" id="valMaxPurchase" style="color: #60a5fa;">$25.00</div>
      </div>
      <div class="card">
        <div class="card-title">Tracked Whale Wallets</div>
        <div class="card-value" id="valTotalWallets" style="color: #a78bfa;">0</div>
      </div>
      <div class="card">
        <div class="card-title">Open Positions</div>
        <div class="card-value" id="valOpenPositions" style="color: #34d399;">0</div>
      </div>
      <div class="card">
        <div class="card-title">Circuit Breaker</div>
        <div class="card-value" id="valCircuitBreaker" style="color: var(--success);">NORMAL</div>
      </div>
    </div>

    <div class="table-container">
      <h2>
        <span>📡 Potential Meme Coins & Signals Stream</span>
        <button class="btn btn-secondary" onclick="simulateSignal()">⚡ Test Inject Signal</button>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Token</th>
            <th>Whale Swap</th>
            <th>Score</th>
            <th>Breakdown & Safety</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="signalsBody">
          <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Memuat sinyal...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- TAB 2: SETTINGS (MENU SETTING & WALLET MANAGEMENT) -->
  <div id="tab-settings" style="display:none;">
    <div class="table-container">
      <h2>⚙️ Konfigurasi Trading, Wallet & Parameter 24/7</h2>
      <p style="color:var(--text-muted); margin-bottom:20px; font-size:0.85rem;">
        Konfigurasi ini langsung tersimpan di PostgreSQL database dan berlaku real-time tanpa perlu restart bot.
      </p>

      <div class="settings-grid">
        <!-- Card 1: Trading & Purchase Rules -->
        <div class="card">
          <h3 style="margin-bottom:14px; font-size:1rem; color:#60a5fa;">💰 Aturan Pembelian & Posisi</h3>
          
          <div class="form-group">
            <label>Mode Trading</label>
            <select id="setPaperTrading">
              <option value="true">Paper Trading (Simulasi Aman Tanpa Resiko Modal)</option>
              <option value="false">Live Trading (Eksekusi Nyata On-Chain)</option>
            </select>
            <span class="hint">Disarankan mulai di Paper Trading untuk evaluasi akurasi sinyal.</span>
          </div>

          <div class="form-group">
            <label>Max Pembelian per Token (USDT / USD)</label>
            <input type="number" id="setTradeAmountUsd" value="25" min="1" step="1">
            <span class="hint">Batas maksimal nominal dana yang dibeli per token koin.</span>
          </div>

          <div class="form-group">
            <label>Maksimal Posisi Terbuka Bersamaan</label>
            <input type="number" id="setMaxOpenPositions" value="5" min="1" max="20">
            <span class="hint">Mencegah over-exposure bila banyak koin muncul serentak.</span>
          </div>

          <div class="form-group">
            <label>Slippage Tolerance (BPS)</label>
            <input type="number" id="setSlippageBps" value="500" step="50">
            <span class="hint">500 BPS = 5.0%, 1000 BPS = 10.0% (meme coin butuh 5-10% toleransi).</span>
          </div>
        </div>

        <!-- Card 2: Risk Management & Exit Strategy -->
        <div class="card">
          <h3 style="margin-bottom:14px; font-size:1rem; color:#f87171;">🛑 Manajemen Risiko & Take-Profit</h3>

          <div class="form-group">
            <label>Stop-Loss Otomatis (%)</label>
            <input type="number" id="setStopLossPercent" value="20" min="5" max="90">
            <span class="hint">Jual otomatis langsung tanpa approval saat harga turun mencapai -% ini.</span>
          </div>

          <div class="form-group">
            <label>Take-Profit Target Awal (%)</label>
            <input type="number" id="setTakeProfitPercent" value="100" min="20" max="1000">
            <span class="hint">Kirim alert [Sell]/[Hold] saat untung mencapai +% ini.</span>
          </div>

          <div class="form-group">
            <label>Take-Profit Step Tambahan Saat [Hold] (%)</label>
            <input type="number" id="setTakeProfitStep" value="50" min="10" max="500">
            <span class="hint">Jika memilih Hold, target dinaikkan ke level berikutnya (misal +150%, +200%).</span>
          </div>

          <div class="form-group">
            <label>Aksi Timeout Sinyal Beli (2 Menit)</label>
            <select id="setBuyTimeoutAction">
              <option value="skip">Skip (Default Aman - Batalkan jika tidak direspon)</option>
              <option value="auto_buy">Auto-Buy (Beli otomatis jika user tidak respon)</option>
            </select>
          </div>
        </div>

        <!-- Card 3: Scoring & Scanner Filter -->
        <div class="card">
          <h3 style="margin-bottom:14px; font-size:1rem; color:#a78bfa;">🎯 Filter Skor Kelayakan (Scoring Engine)</h3>

          <div class="form-group">
            <label>Minimal Skor untuk Alert (0 - 100)</label>
            <input type="number" id="setScoringThreshold" value="75" min="50" max="95">
            <span class="hint">Hanya token dengan skor $\ge$ nilai ini yang dikirim ke Telegram.</span>
          </div>

          <div class="form-group">
            <label>Minimal Likuiditas Pool (USD)</label>
            <input type="number" id="setMinLiquidityUsd" value="10000" step="1000">
            <span class="hint">Filter token dengan likuiditas terlalu tipis (rawan slippage besar).</span>
          </div>

          <div class="form-group">
            <label>Interval Pemindaian Wallet (Detik)</label>
            <input type="number" id="setAutoScanIntervalSec" value="20" min="10" max="120">
            <span class="hint">Frekuensi worker memindai on-chain histori seluruh wallet whale (24/7).</span>
          </div>
        </div>

        <!-- Card 4: Wallet & Telegram Integration -->
        <div class="card">
          <h3 style="margin-bottom:14px; font-size:1rem; color:#34d399;">🔑 Konfigurasi Wallet & Telegram</h3>

          <div class="form-group">
            <label>Solana Wallet Address Saya</label>
            <input type="text" id="setMySolanaWallet" placeholder="Alamat Public Wallet Anda">
          </div>

          <div class="form-group">
            <label>Solana Private Key (Opsional - untuk Live Mode)</label>
            <input type="password" id="setMySolanaPrivateKey" placeholder="Base58 Private Key (Rahasia)">
            <span class="hint">Tersimpan aman di database lokal. Kosongkan bila di Paper Trading.</span>
          </div>

          <div class="form-group">
            <label>Telegram Bot Token</label>
            <input type="text" id="setTelegramBotToken" placeholder="Contoh: 123456789:ABCdef...">
          </div>

          <div class="form-group">
            <label>Telegram Chat ID</label>
            <input type="text" id="setTelegramChatId" placeholder="User ID atau Group ID Anda">
          </div>

          <button class="btn btn-secondary" onclick="testTelegramNotification()" style="margin-top:6px;">📲 Test Notifikasi Telegram</button>
        </div>
      </div>

      <div style="margin-top:24px; display:flex; justify-content:flex-end;">
        <button class="btn btn-success" onclick="saveSettings()" style="padding:12px 28px; font-size:1rem;">💾 Simpan Konfigurasi</button>
      </div>
    </div>
  </div>

  <!-- TAB 3: WHALE WATCHLIST -->
  <div id="tab-wallets" style="display:none;">
    <div class="table-container">
      <h2>
        <span>🐋 Whale Wallets Watchlist (Auto-Scanner 24/7)</span>
        <div>
          <button class="btn btn-purple" onclick="autoDiscoverWhales()">⚡ Auto-Discover Whales</button>
          <button class="btn btn-primary" onclick="scanAllWalletsNow()" style="margin-left: 8px;">🔍 Scan All Now</button>
        </div>
      </h2>
      <div style="margin-bottom: 14px; display: flex; gap: 8px; flex-wrap: wrap;">
        <input type="text" id="newWalletAddress" placeholder="Tambah Alamat Whale (Solana / EVM)" style="width: 320px;">
        <input type="text" id="newWalletLabel" placeholder="Label / Nickname" style="width: 180px;">
        <select id="newWalletChain" style="width:140px;">
          <option value="solana">Solana</option>
          <option value="evm">EVM (ETH/BSC)</option>
        </select>
        <button class="btn btn-success" onclick="addNewWallet()">+ Tambah Wallet</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Whale Label</th>
            <th>Address</th>
            <th>Chain</th>
            <th>Tags</th>
            <th>Last Scanned</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="walletsBody">
          <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Memuat watched wallets...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- TAB 4: POSITIONS & HISTORY -->
  <div id="tab-positions" style="display:none;">
    <div class="table-container">
      <h2>📈 Posisi Terbuka (Active Positions)</h2>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Entry Price</th>
            <th>Current Price</th>
            <th>PnL %</th>
            <th>TP Target</th>
            <th>Opened</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="positionsBody">
          <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Tidak ada posisi terbuka</td></tr>
        </tbody>
      </table>
    </div>

    <div class="table-container">
      <h2>📜 Riwayat Eksekusi Trade (BUY & SELL)</h2>
      <table>
        <thead>
          <tr>
            <th>Waktu</th>
            <th>Side</th>
            <th>Token Address</th>
            <th>Harga</th>
            <th>Total USD</th>
            <th>Mode</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="tradesBody">
          <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Memuat riwayat...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }

    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tab-overview').style.display = 'none';
      document.getElementById('tab-settings').style.display = 'none';
      document.getElementById('tab-wallets').style.display = 'none';
      document.getElementById('tab-positions').style.display = 'none';

      document.getElementById('tab-' + tab).style.display = 'block';
      event?.target?.classList?.add('active');

      if (tab === 'settings') loadSettings();
      if (tab === 'positions') loadTrades();
    }

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const s = await res.json();
        document.getElementById('setPaperTrading').value = s.paperTrading ? 'true' : 'false';
        document.getElementById('setTradeAmountUsd').value = s.tradeAmountUsd || 25;
        document.getElementById('setMaxOpenPositions').value = s.maxOpenPositions || 5;
        document.getElementById('setSlippageBps').value = s.slippageBps || 500;
        document.getElementById('setStopLossPercent').value = s.stopLossPercent || 20;
        document.getElementById('setTakeProfitPercent').value = s.takeProfitPercent || 100;
        document.getElementById('setTakeProfitStep').value = s.takeProfitStep || 50;
        document.getElementById('setBuyTimeoutAction').value = s.buyTimeoutAction || 'skip';
        document.getElementById('setScoringThreshold').value = s.scoringThreshold || 75;
        document.getElementById('setMinLiquidityUsd').value = s.minLiquidityUsd || 10000;
        document.getElementById('setAutoScanIntervalSec').value = s.autoScanIntervalSec || 20;
        document.getElementById('setMySolanaWallet').value = s.mySolanaWallet || '';
        document.getElementById('setMySolanaPrivateKey').value = s.mySolanaPrivateKey || '';
        document.getElementById('setTelegramBotToken').value = s.telegramBotToken || '';
        document.getElementById('setTelegramChatId').value = s.telegramChatId || '';
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    }

    async function saveSettings() {
      const data = {
        paperTrading: document.getElementById('setPaperTrading').value === 'true',
        tradeAmountUsd: parseFloat(document.getElementById('setTradeAmountUsd').value),
        maxOpenPositions: parseInt(document.getElementById('setMaxOpenPositions').value),
        slippageBps: parseInt(document.getElementById('setSlippageBps').value),
        stopLossPercent: parseFloat(document.getElementById('setStopLossPercent').value),
        takeProfitPercent: parseFloat(document.getElementById('setTakeProfitPercent').value),
        takeProfitStep: parseFloat(document.getElementById('setTakeProfitStep').value),
        buyTimeoutAction: document.getElementById('setBuyTimeoutAction').value,
        scoringThreshold: parseFloat(document.getElementById('setScoringThreshold').value),
        minLiquidityUsd: parseFloat(document.getElementById('setMinLiquidityUsd').value),
        autoScanIntervalSec: parseInt(document.getElementById('setAutoScanIntervalSec').value),
        mySolanaWallet: document.getElementById('setMySolanaWallet').value.trim(),
        mySolanaPrivateKey: document.getElementById('setMySolanaPrivateKey').value.trim(),
        telegramBotToken: document.getElementById('setTelegramBotToken').value.trim(),
        telegramChatId: document.getElementById('setTelegramChatId').value.trim(),
      };

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (result.success) {
        showToast('✅ Pengaturan Berhasil Disimpan!');
        loadData();
      } else {
        alert('Gagal menyimpan: ' + (result.error || 'Unknown error'));
      }
    }

    async function testTelegramNotification() {
      const telegramBotToken = document.getElementById('setTelegramBotToken').value.trim();
      const telegramChatId = document.getElementById('setTelegramChatId').value.trim();
      if (!telegramBotToken || !telegramChatId) {
        return alert('Harap isi Telegram Bot Token dan Chat ID terlebih dahulu!');
      }

      showToast('Mengirim notifikasi tes ke Telegram...');
      const res = await fetch('/api/settings/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramBotToken, telegramChatId })
      });
      const result = await res.json();
      if (result.success) {
        alert('✅ Pesan berhasil dikirim ke Telegram Anda!');
      } else {
        alert('❌ Gagal: ' + (result.error || 'Cek kembali token bot dan chat ID'));
      }
    }

    async function loadTrades() {
      try {
        const res = await fetch('/api/trades');
        const trades = await res.json();
        const tBody = document.getElementById('tradesBody');
        if (trades.length === 0) {
          tBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Belum ada riwayat trade</td></tr>';
        } else {
          tBody.innerHTML = trades.map(t => {
            const sideClass = t.side === 'BUY' ? 'pnl-positive' : 'pnl-negative';
            return \`
              <tr>
                <td>\${new Date(t.createdAt).toLocaleTimeString()}</td>
                <td class="\${sideClass}"><strong>\${t.side}</strong></td>
                <td><code style="color:#93c5fd;">\${t.tokenAddress.substring(0,8)}...</code></td>
                <td>$\${t.price.toFixed(6)}</td>
                <td>$\${t.totalUsd.toFixed(2)}</td>
                <td><span class="badge badge-paper">\${t.isPaper ? 'Paper' : 'Live'}</span></td>
                <td><span class="badge badge-open">\${t.status}</span></td>
              </tr>
            \`;
          }).join('');
        }
      } catch (err) {
        console.error('Failed to load trades:', err);
      }
    }

    async function loadData() {
      try {
        const [signalsRes, positionsRes, cbRes, walletsRes, settingsRes] = await Promise.all([
          fetch('/api/signals'),
          fetch('/api/positions'),
          fetch('/api/circuit-breaker'),
          fetch('/api/wallets'),
          fetch('/api/settings')
        ]);
        const signals = await signalsRes.json();
        const positions = await positionsRes.json();
        const cb = await cbRes.json();
        const wallets = await walletsRes.json();
        const settings = await settingsRes.json();

        // Update Overview Cards
        document.getElementById('valMaxPurchase').innerText = '$' + (settings.tradeAmountUsd || 25).toFixed(2);
        const modeBadge = document.getElementById('badgeTradingMode');
        if (settings.paperTrading) {
          modeBadge.innerText = 'Mode: Paper Trading (Simulasi)';
          modeBadge.className = 'badge badge-paper';
        } else {
          modeBadge.innerText = 'Mode: Live Trading (On-Chain)';
          modeBadge.className = 'badge badge-live';
        }

        const activeWallets = wallets.filter(w => w.isActive);
        document.getElementById('valTotalWallets').innerText = activeWallets.length + ' / ' + wallets.length;
        const openPositions = positions.filter(p => p.status === 'open');
        document.getElementById('valOpenPositions').innerText = openPositions.length;
        const cbEl = document.getElementById('valCircuitBreaker');
        if (cb.isTripped) {
          cbEl.innerText = 'TRIPPED';
          cbEl.style.color = 'var(--danger)';
        } else {
          cbEl.innerText = 'NORMAL';
          cbEl.style.color = 'var(--success)';
        }

        // Render Wallets
        const wBody = document.getElementById('walletsBody');
        if (wallets.length === 0) {
          wBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Belum ada wallet dipantau. Klik "Auto-Discover Whales" untuk memindai otomatis!</td></tr>';
        } else {
          wBody.innerHTML = wallets.map(w => {
            const tagsHtml = (w.tags || []).map(t => \`<span class="badge badge-tag">\${t}</span>\`).join('');
            const lastScanned = w.lastScannedAt ? new Date(w.lastScannedAt).toLocaleTimeString() : 'Pending';
            const toggleBtn = w.isActive
              ? \`<button class="btn btn-secondary" onclick="toggleWallet('\${w.id}')">Pause</button>\`
              : \`<button class="btn btn-success" onclick="toggleWallet('\${w.id}')">Activate</button>\`;

            return \`
              <tr>
                <td><strong>\${w.label || 'Whale Wallet'}</strong></td>
                <td><code style="font-size:0.8rem; color:#93c5fd;">\${w.address.substring(0,6)}...\${w.address.substring(w.address.length-6)}</code></td>
                <td><span class="badge badge-paper">\${w.chain.toUpperCase()}</span></td>
                <td>\${tagsHtml}</td>
                <td><small style="color:var(--text-muted);">\${lastScanned}</small></td>
                <td><span class="badge \${w.isActive ? 'badge-open' : 'badge-closed'}">\${w.isActive ? 'Active' : 'Paused'}</span></td>
                <td>
                  \${toggleBtn}
                  <button class="btn btn-danger" onclick="deleteWallet('\${w.id}')" style="margin-left:4px;">Del</button>
                </td>
              </tr>
            \`;
          }).join('');
        }

        // Render Positions
        const pBody = document.getElementById('positionsBody');
        if (openPositions.length === 0) {
          pBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Tidak ada posisi terbuka saat ini</td></tr>';
        } else {
          pBody.innerHTML = openPositions.map(p => {
            const pnlClass = p.pnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative';
            return \`
              <tr>
                <td><strong>\${p.tokenSymbol}</strong><br><small style="color:var(--text-muted)">\${p.tokenAddress.substring(0,8)}...</small></td>
                <td>$\${p.entryPrice.toFixed(6)}</td>
                <td>$\${p.currentPrice.toFixed(6)}</td>
                <td class="\${pnlClass}">\${p.pnlPercent >= 0 ? '+' : ''}\${p.pnlPercent.toFixed(2)}%</td>
                <td>+\${p.nextTpThreshold}%</td>
                <td>\${new Date(p.openedAt).toLocaleTimeString()}</td>
                <td><button class="btn btn-danger" onclick="closePosition('\${p.id}')">Manual Close</button></td>
              </tr>
            \`;
          }).join('');
        }

        // Render Signals
        const sBody = document.getElementById('signalsBody');
        if (signals.length === 0) {
          sBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Belum ada sinyal tercatat</td></tr>';
        } else {
          sBody.innerHTML = signals.map(s => {
            const score = s.score?.totalScore ?? 'N/A';
            const scoreColor = score >= 75 ? 'var(--success)' : (score >= 50 ? 'var(--warning)' : 'var(--danger)');
            const actionBtn = s.status === 'pending_approval' 
              ? \`<button class="btn btn-success" onclick="approveSignal('\${s.id}')">Approve</button> <button class="btn btn-danger" onclick="skipSignal('\${s.id}')">Skip</button>\`
              : \`<span style="color:var(--text-muted)">-</span>\`;

            return \`
              <tr>
                <td>\${new Date(s.createdAt).toLocaleTimeString()}</td>
                <td><strong>\${s.tokenSymbol || 'TOKEN'}</strong><br><small style="color:var(--text-muted)">\${s.chain}</small></td>
                <td>$\${(s.amountUsd || 0).toLocaleString()}</td>
                <td><strong style="color: \${scoreColor}; font-size:1.15rem;">\${score}</strong>/100</td>
                <td><small>\${s.score?.hardFailReasons?.[0] || 'Score computed'}</small></td>
                <td><span class="badge badge-paper">\${s.status}</span></td>
                <td>\${actionBtn}</td>
              </tr>
            \`;
          }).join('');
        }
      } catch (err) {
        console.error('Error fetching data:', err);
      }
    }

    async function autoDiscoverWhales() {
      showToast('Memindai trending meme coins untuk mencari whale baru...');
      const res = await fetch('/api/wallets/auto-discover', { method: 'POST' });
      const data = await res.json();
      showToast(\`Ditemukan \${data.result?.newWalletsFound || 0} whale baru!\`);
      loadData();
    }

    async function scanAllWalletsNow() {
      showToast('Memindai histori on-chain seluruh whale...');
      const res = await fetch('/api/wallets/scan-now', { method: 'POST' });
      const data = await res.json();
      showToast(\`Selesai memindai \${data.result?.scannedCount || 0} wallet!\`);
      loadData();
    }

    async function addNewWallet() {
      const address = document.getElementById('newWalletAddress').value.trim();
      const label = document.getElementById('newWalletLabel').value.trim();
      const chain = document.getElementById('newWalletChain').value;
      if (!address) return alert('Masukkan alamat wallet!');

      await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, label, chain })
      });
      document.getElementById('newWalletAddress').value = '';
      document.getElementById('newWalletLabel').value = '';
      showToast('Wallet berhasil ditambahkan!');
      loadData();
    }

    async function toggleWallet(id) {
      await fetch('/api/wallets/' + id + '/toggle', { method: 'POST' });
      loadData();
    }

    async function deleteWallet(id) {
      if (confirm('Hapus wallet dari daftar pantau?')) {
        await fetch('/api/wallets/' + id, { method: 'DELETE' });
        loadData();
      }
    }

    async function simulateSignal() {
      await fetch('/api/simulate-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountUsd: 18000 })
      });
      showToast('Sinyal simulasi berhasil diinjeksikan!');
      setTimeout(loadData, 1500);
    }

    async function approveSignal(id) {
      await fetch('/api/signals/' + id + '/approve', { method: 'POST' });
      showToast('Sinyal di-approve!');
      setTimeout(loadData, 1000);
    }

    async function skipSignal(id) {
      await fetch('/api/signals/' + id + '/skip', { method: 'POST' });
      showToast('Sinyal di-skip!');
      setTimeout(loadData, 500);
    }

    async function closePosition(id) {
      await fetch('/api/positions/' + id + '/close', { method: 'POST' });
      showToast('Posisi berhasil ditutup manual!');
      setTimeout(loadData, 1000);
    }

    setInterval(loadData, 5000);
    loadData();
  </script>
</body>
</html>`;
}
