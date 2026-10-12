# 🐋 Whale-Signal Meme Coin Trading Bot

Sistem trading bot otomatis berbasis event & whale signal on-chain untuk mendeteksi transaksi whale, menganalisis keamanan kontrak dan likuiditas token, menghitung skor kelayakan, serta mengeksekusi buy/sell dengan mekanisme approval Telegram, auto stop-loss (-20%), dan take-profit (+100%).

Dibangun berdasarkan spesifikasi teknis dari [Blueprint: Whale-Signal Meme Coin Trading Bot](Blueprint_%20Whale-Signal%20Trading%20Bot.html).

---

## 🏗️ Tech Stack & Arsitektur

- **Runtime & Bahasa:** Node.js (v26.11+) + TypeScript
- **Database:** PostgreSQL (via Prisma ORM 6)
- **Queue & Async Worker:** Redis 7 + BullMQ 5
- **Whale Watcher:** Helius Webhook (Solana) & Alchemy (EVM) + **Multi-Wallet Periodic On-Chain Scanner**
- **Whale Discovery:** Auto-Discovery top holders dari trending meme coins + curated presets smart money
- **Data Aggregator:** DexScreener API & GoPlus Security API
- **Scoring Engine:** Algoritma Multi-faktor weighted dengan Hard-fail rules
- **Telegram Bot:** grammY framework (Inline keyboard callbacks)
- **Eksekutor:** Jupiter Aggregator API / Paper Trading Simulation
- **Containerization:** Docker Compose (PostgreSQL & Redis)
- **Testing:** Vitest

---

## 🔍 Fitur Baru: Multi-Wallet Whale Auto-Scanner & Discovery

Sistem kini tidak hanya menunggu webhook pasif untuk 1 wallet, melainkan mampu memantau **puluhan hingga ratusan wallet whale secara otomatis**:

1. **Auto-Discovery dari Trending Meme Coins:**
   - Bot otomatis memindai token meme yang sedang trending/hot di Solana (seperti BONK, WIF, POPCAT, FARTCOIN, GOAT, dsb).
   - Mengekstrak top holder wallets yang profitable (menyaring liquidity pool, exchange, dan burn address).
   - Menambahkan wallet whale tersebut ke dalam watchlist database PostgreSQL secara dinamis.
2. **Curated Smart Money & Sniper Presets:**
   - Menyertakan daftar wallet whale terkurasi (early snipers, high-winrate meme traders, pump.fun specialists, dan MEV whales).
3. **Automated On-Chain Periodic Scanner:**
   - BullMQ worker memindai histori transaksi on-chain (`getSignaturesForAddress` & `getParsedTransaction`) untuk semua wallet aktif secara berkala (tiap 30 detik).
   - Setiap kali terdeteksi whale swap baru pada token non-bluechip, langsung otomatis diteruskan ke pipeline Aggregator $\rightarrow$ Scoring Engine $\rightarrow$ Telegram Approval!
4. **Dashboard Watchlist Management:**
   - Monitor status dan timestamp pemindaian seluruh whale wallet di `http://localhost:3000`.
   - Tombol **"⚡ Auto-Discover Whales"** untuk mencari whale baru secara instan.
   - Tombol **"🔍 Scan All Now"** untuk memicu pemindaian on-chain manual.
   - Fitur Pause/Activate dan Add Custom Whale Wallet dengan label dan tag kustom.

---

## 🔄 Alur Sistem (Flow)

```
Whale Swap Terdeteksi (Helius/Alchemy Webhook)
         │
         ▼
Token Data Aggregator ──► Scoring Engine ──► Skor ≥ 80?
(DexScreener, GoPlus)     (Bobot Multi-faktor)        │
                                                      │ Ya
                                                      ▼
                                       Telegram Alert: [Approve] [Skip]
                                                      │
                       ┌──────────────────────────────┴──────────────────────────────┐
                       │ Approve dalam 2 menit                                       │ Timeout / Skip
                       ▼                                                             ▼
             Trade Executor: BUY                                            Status: timeout_expired
                       │                                                    (Tidak beli, simpan log)
                       ▼
             Position Monitor (Interval 15s)
               │                             │
    Harga turun ≤ -20%              Harga naik ≥ +100%
               │                             │
               ▼                             ▼
       AUTO SELL Langsung           Telegram Alert: [Sell] [Hold]
    (Stop loss tanpa approval)       ┌───────────────┴───────────────┐
                                  Sell / Approve                  Timeout 2 menit
                                     │                               │
                                Jual Posisi                  AUTO SELL (Default Aman)
```

---

## 📊 Matriks Scoring Engine (0 - 100)

| Faktor | Bobot | Kriteria & Formula |
| :--- | :--- | :--- |
| **Liquidity Locked & Size** | 25% | Pool $\ge \$100K$ & Locked $\rightarrow 100$. Skor 0 jika tidak locked atau $<\$10K$. |
| **Top 10 Holder Concentration** | 20% | $\le 20\% \rightarrow 100$. $\ge 70\% \rightarrow 0$. Tersebar lebih aman. |
| **Contract Safety** | 25% | Honeypot $\rightarrow 0$ (Hard Fail). Penalti jika ada mintable function atau ownership unrenounced. |
| **Volume / Market Cap Ratio** | 15% | Sehat antara $0.1 - 1.5$. Penalti jika rasio sangat rendah atau indikasi wash trade. |
| **Umur Token & Holder Count** | 15% | Umur $< 1$ jam dipotong penalti; jumlah holder tinggi $(>500)$ menambah skor. |

### 🚨 Hard-Fail Rules
Jika salah satu kondisi berikut terpenuhi, skor langsung dipaksa ke $\le 15$ dan dibatalkan otomatis:
1. Terdeteksi honeypot oleh GoPlus Security API.
2. Likuiditas tidak terkunci (unlocked) dan $<\$5,000$.
3. Kontrak tidak terverifikasi dan likuiditas $\$0$.

---

## 🚀 Cara Menjalankan

### 1. Prasyarat
- Docker & Docker Compose
- Node.js (v20+) & npm (via fish nvm atau bash)

### 2. Jalankan Container Database & Redis
```bash
docker compose up -d
```

### 3. Setup Environment Variables
Salin template `.env.example` ke `.env`:
```bash
cp .env.example .env
```
Isi konfigurasi Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) dan Helius/Alchemy jika menggunakan live watcher. Secara default, `PAPER_TRADING=true` aktif untuk mode simulasi aman tanpa risiko dana.

### 4. Sinkronisasi Schema Database
```bash
npx prisma db push
```

### 5. Jalankan Test Suite
```bash
npm test
```

### 6. Jalankan Server & Bot
```bash
npm start
```
Buka dashboard browser di: **`http://localhost:3000`**

---

## 🛡️ Fitur Keamanan & Circuit Breaker

1. **Paper Trading Simulation Mode:** Mode default agar semua eksekusi BUY/SELL disimulasikan secara presisi (menghitung slippage, entry/exit price, dan PnL) sebelum memasukkan private key asli.
2. **Circuit Breaker:** Jika terjadi $\ge 3$ stop-loss berturut-turut dalam kurun waktu 60 menit, sistem otomatis membekukan order BUY baru untuk melindungi portofolio.
3. **Approval Timeouts:**
   - Fase BUY: Timeout 2 menit default **SKIP** (menghindari beli acak saat user tidak sengaja luput).
   - Fase TAKE-PROFIT: Timeout 2 menit default **AUTO SELL** (mengunci keuntungan sebelum dump).
4. **Audit Logging:** Setiap keputusan otomatis dicatat di tabel `audit_logs` dengan alasan dan timestamp.
