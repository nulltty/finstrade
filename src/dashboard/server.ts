import express from 'express';
import cors from 'cors';
import { prisma } from '../db/prisma.js';
import { whaleWatcherService } from '../services/watcher.js';
import { whaleDiscovery } from '../services/discovery.js';
import { multiWalletScanner } from '../services/scanner.js';
import { circuitBreaker } from '../services/circuitBreaker.js';
import { tradeExecutor } from '../services/executor.js';
import { telegramBot } from '../bot/telegram.js';
import { env } from '../config/index.js';
import { logger } from '../services/logger.js';

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), paperTrading: env.PAPER_TRADING });
  });

  // 1. Webhooks
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

  // 2. Whale Wallets Management APIs
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

  // 3. Signals, Positions & Trades APIs
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

  // Simulation endpoint for testnet/paper verification
  app.post('/api/simulate-signal', async (req, res) => {
    try {
      const {
        wallet = 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
        chain = 'solana',
        tokenAddress = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK on Solana
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

  // 4. Web UI Dashboard
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
  <title>Whale-Signal Meme Coin Trading Bot Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 0.75rem;
      padding: 4px 8px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-paper { background: #374151; color: #60a5fa; border: 1px solid #1e40af; }
    .badge-live { background: #064e3b; color: #34d399; }
    .badge-open { background: #064e3b; color: #34d399; }
    .badge-closed { background: #374151; color: #9ca3af; }
    .badge-tag { background: #1e1b4b; color: #a5b4fc; border: 1px solid #3730a3; margin-right: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card-title { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; }
    .card-value { font-size: 1.75rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
      overflow-x: auto;
    }
    h2 { font-size: 1.15rem; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid var(--border); }
    .pnl-positive { color: var(--success); font-weight: 600; font-family: 'JetBrains Mono', monospace; }
    .pnl-negative { color: var(--danger); font-weight: 600; font-family: 'JetBrains Mono', monospace; }
    .btn {
      padding: 6px 12px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.8rem;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-success { background: var(--success); color: white; }
    .btn-purple { background: var(--purple); color: white; }
    .btn-secondary { background: #374151; color: white; }
    .panel {
      background: #111827;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .sim-panel {
      background: #1e1b4b;
      border: 1px solid #4338ca;
    }
    input, select {
      background: #0f172a;
      border: 1px solid #334155;
      padding: 8px 12px;
      border-radius: 6px;
      color: white;
      font-family: inherit;
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>🐋 Whale-Signal Meme Coin Trading Bot</h1>
    <div>
      <span class="badge badge-paper">Mode: Paper Trading Active</span>
      <button class="btn btn-primary" onclick="loadData()" style="margin-left: 8px;">🔄 Refresh</button>
    </div>
  </header>

  <div class="panel sim-panel">
    <strong>🧪 Test Simulation:</strong>
    <input type="text" id="simToken" placeholder="Token Mint / Contract" value="DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" style="width: 320px;">
    <input type="text" id="simSymbol" placeholder="Symbol" value="BONK" style="width: 80px;">
    <input type="number" id="simAmount" placeholder="Whale Swap USD" value="15000" style="width: 120px;">
    <button class="btn btn-success" onclick="simulateSignal()">⚡ Inject Whale Signal</button>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Tracked Whale Wallets</div>
      <div class="card-value" id="valTotalWallets" style="color: #a78bfa;">0</div>
    </div>
    <div class="card">
      <div class="card-title">Open Positions</div>
      <div class="card-value" id="valOpenPositions">0</div>
    </div>
    <div class="card">
      <div class="card-title">Total Signals Detected</div>
      <div class="card-value" id="valTotalSignals">0</div>
    </div>
    <div class="card">
      <div class="card-title">Circuit Breaker</div>
      <div class="card-value" id="valCircuitBreaker" style="color: var(--success);">NORMAL</div>
    </div>
  </div>

  <div class="table-container">
    <h2>
      <span>🔍 Whale Wallets Watchlist (Auto-Scanner Active)</span>
      <div>
        <button class="btn btn-purple" onclick="autoDiscoverWhales()">⚡ Auto-Discover Whales</button>
        <button class="btn btn-primary" onclick="scanAllWalletsNow()" style="margin-left: 8px;">🔍 Scan All Now</button>
      </div>
    </h2>
    <div style="margin-bottom: 14px; display: flex; gap: 8px; flex-wrap: wrap;">
      <input type="text" id="newWalletAddress" placeholder="Add Whale Address (Solana / EVM)" style="width: 320px;">
      <input type="text" id="newWalletLabel" placeholder="Label / Nickname" style="width: 180px;">
      <select id="newWalletChain">
        <option value="solana">Solana</option>
        <option value="evm">EVM (ETH/BSC)</option>
      </select>
      <button class="btn btn-success" onclick="addNewWallet()">+ Add Wallet</button>
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
        <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Loading watched wallets...</td></tr>
      </tbody>
    </table>
  </div>

  <div class="table-container">
    <h2>📈 Active Positions</h2>
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
        <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No open positions</td></tr>
      </tbody>
    </table>
  </div>

  <div class="table-container">
    <h2>📡 Whale Signals Stream</h2>
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Token</th>
          <th>Whale Swap</th>
          <th>Score</th>
          <th>Safety & Liquidity</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="signalsBody">
        <tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Loading signals...</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    async function loadData() {
      try {
        const [signalsRes, positionsRes, cbRes, walletsRes] = await Promise.all([
          fetch('/api/signals'),
          fetch('/api/positions'),
          fetch('/api/circuit-breaker'),
          fetch('/api/wallets')
        ]);
        const signals = await signalsRes.json();
        const positions = await positionsRes.json();
        const cb = await cbRes.json();
        const wallets = await walletsRes.json();

        // Update stats
        const activeWallets = wallets.filter(w => w.isActive);
        document.getElementById('valTotalWallets').innerText = activeWallets.length + ' / ' + wallets.length;
        const openPositions = positions.filter(p => p.status === 'open');
        document.getElementById('valOpenPositions').innerText = openPositions.length;
        document.getElementById('valTotalSignals').innerText = signals.length;
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
          wBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No wallets in watchlist. Click "Auto-Discover Whales" to populate automatically!</td></tr>';
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
          pBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No open positions</td></tr>';
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
                <td><button class="btn btn-danger" onclick="closePosition('\${p.id}')">Close</button></td>
              </tr>
            \`;
          }).join('');
        }

        // Render Signals
        const sBody = document.getElementById('signalsBody');
        if (signals.length === 0) {
          sBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No signals recorded</td></tr>';
        } else {
          sBody.innerHTML = signals.map(s => {
            const score = s.score?.totalScore ?? 'N/A';
            const scoreColor = score >= 80 ? 'var(--success)' : (score >= 50 ? 'var(--warning)' : 'var(--danger)');
            const actionBtn = s.status === 'pending_approval' 
              ? \`<button class="btn btn-success" onclick="approveSignal('\${s.id}')">Approve</button> <button class="btn btn-danger" onclick="skipSignal('\${s.id}')">Skip</button>\`
              : \`<span style="color:var(--text-muted)">-</span>\`;

            return \`
              <tr>
                <td>\${new Date(s.createdAt).toLocaleTimeString()}</td>
                <td><strong>\${s.tokenSymbol || 'TOKEN'}</strong><br><small style="color:var(--text-muted)">\${s.chain}</small></td>
                <td>$\${(s.amountUsd || 0).toLocaleString()}</td>
                <td><strong style="color: \${scoreColor}; font-size:1.1rem;">\${score}</strong>/100</td>
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
      const btn = event?.target;
      if (btn) btn.innerText = '⏳ Scanning Trending...';
      const res = await fetch('/api/wallets/auto-discover', { method: 'POST' });
      const data = await res.json();
      if (btn) btn.innerText = '⚡ Auto-Discover Whales';
      alert(\`Discovered \${data.result?.newWalletsFound || 0} new whale wallets from trending meme coins!\`);
      loadData();
    }

    async function scanAllWalletsNow() {
      const btn = event?.target;
      if (btn) btn.innerText = '🔍 Scanning On-Chain...';
      const res = await fetch('/api/wallets/scan-now', { method: 'POST' });
      const data = await res.json();
      if (btn) btn.innerText = '🔍 Scan All Now';
      alert(\`Scanned \${data.result?.scannedCount || 0} wallets. Signals found: \${data.result?.signalsFound || 0}\`);
      loadData();
    }

    async function addNewWallet() {
      const address = document.getElementById('newWalletAddress').value.trim();
      const label = document.getElementById('newWalletLabel').value.trim();
      const chain = document.getElementById('newWalletChain').value;
      if (!address) return alert('Please enter wallet address');

      await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, label, chain })
      });
      document.getElementById('newWalletAddress').value = '';
      document.getElementById('newWalletLabel').value = '';
      loadData();
    }

    async function toggleWallet(id) {
      await fetch('/api/wallets/' + id + '/toggle', { method: 'POST' });
      loadData();
    }

    async function deleteWallet(id) {
      if (confirm('Remove wallet from watchlist?')) {
        await fetch('/api/wallets/' + id, { method: 'DELETE' });
        loadData();
      }
    }

    async function simulateSignal() {
      const tokenAddress = document.getElementById('simToken').value;
      const tokenSymbol = document.getElementById('simSymbol').value;
      const amountUsd = Number(document.getElementById('simAmount').value);

      await fetch('/api/simulate-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenAddress, tokenSymbol, amountUsd })
      });
      setTimeout(loadData, 1500);
    }

    async function approveSignal(id) {
      await fetch('/api/signals/' + id + '/approve', { method: 'POST' });
      setTimeout(loadData, 1000);
    }

    async function skipSignal(id) {
      await fetch('/api/signals/' + id + '/skip', { method: 'POST' });
      setTimeout(loadData, 500);
    }

    async function closePosition(id) {
      await fetch('/api/positions/' + id + '/close', { method: 'POST' });
      setTimeout(loadData, 1000);
    }

    setInterval(loadData, 5000);
    loadData();
  </script>
</body>
</html>`;
}
