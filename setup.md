# Setup — Apa Saja yang Perlu Disiapkan

Semua layanan pihak ke-3 yang dipakai bot ini **gratis dan tanpa langganan**. Sebagian besar bahkan tidak butuh API key sama sekali.

---

## 1. Ringkasan layanan

| Layanan | Untuk apa | Biaya | Perlu daftar / API key? |
|---|---|---|---|
| **DexScreener** | Harga, likuiditas, volume, token trending | Gratis | ❌ Tidak |
| **GoPlus Security** | Cek kontrak: mint, freeze, honeypot, transfer fee | Gratis | ❌ Tidak |
| **RugCheck** | LP lock/burn, top holder, insider, status rug | Gratis | ❌ Tidak |
| **Jupiter** | Simulasi jual (deteksi honeypot) + eksekusi swap | Gratis | ❌ Tidak |
| **GeckoTerminal** | Candle OHLCV untuk RSI (strategy 2 — dip reversal) | Gratis | ❌ Tidak |
| **Solana RPC publik** | Baca transaksi whale & saldo wallet | Gratis | ❌ Tidak |
| **Telegram Bot** | Notifikasi & tombol approve | Gratis | ✅ Buat bot di @BotFather (gratis, 2 menit) |
| **Helius** *(opsional, sangat disarankan)* | RPC Solana yang jauh lebih cepat | Free plan | ✅ Akun gratis → API key |

**Tidak perlu** (meskipun disebut di blueprint): Alchemy, Moralis, Birdeye, Bubblemaps, 1inch, Supabase, Doppler, Railway/Fly.io. Bot ini hanya untuk Solana dan jalan di komputer/VPS kamu sendiri dengan Docker.

> **Minimal untuk jalan:** Docker + Node.js. Bot sudah bisa jalan tanpa API key apa pun (mode paper). Telegram dan Helius bisa ditambahkan kapan saja.

---

## 2. Software di komputer / server

| Software | Cek dengan | Catatan |
|---|---|---|
| Mac Studio: **tidak perlu install apa-apa** | — | `scripts/mac-setup.sh` menginstall semuanya (Homebrew, Node, PostgreSQL, Redis) |
| PC/Linux: Docker + Docker Compose | `docker compose version` | Untuk PostgreSQL & Redis (dan bot-nya, kalau mau 24/7) |
| Node.js ≥ 20 + npm | `node -v` · `npm -v` | Hanya perlu kalau menjalankan bot di luar Docker |
| Git | `git --version` | — |

Supaya benar-benar 24/7, komputernya harus menyala terus. Rekomendasi: **Mac Studio** (idle sangat hemat daya; setup otomatis di bagian 6). Bot ini ringan, jadi VPS 1 vCPU / 1–2 GB RAM juga cukup.

---

## 3. Telegram (gratis) — untuk notifikasi

### a. Buat bot → dapat `TELEGRAM_BOT_TOKEN`
1. Buka Telegram, cari **@BotFather**, kirim `/newbot`.
2. Isi nama bot dan username (harus diakhiri `bot`, misal `fins_trade_bot`).
3. BotFather memberi token seperti `1234567890:AAH...xyz`. **Simpan, jangan dibagikan.**

### b. Dapatkan `TELEGRAM_CHAT_ID` dan `TELEGRAM_ADMIN_IDS`
1. Buka bot yang baru dibuat, tekan **Start** (atau kirim `/start`).
2. Di browser buka (ganti `<TOKEN>`):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Cari `"chat":{"id": 123456789 ...}` → itu **chat ID**.
   Untuk chat pribadi, angka yang sama juga **user ID** kamu → isi ke `TELEGRAM_ADMIN_IDS`.
   - Kalau hasilnya kosong (`"result":[]`), kirim satu pesan lagi ke bot lalu refresh.
   - Mau notif ke grup? Masukkan bot ke grup, kirim pesan di grup, lalu ambil chat ID grup (diawali `-100…`).

`TELEGRAM_ADMIN_IDS` membatasi siapa yang boleh menekan tombol Approve/Sell/Hold. **Isi ini**, terutama kalau bot dipasang di grup. Kalau kosong, semua anggota chat bisa menekan tombol.

Token & chat ID bisa diisi di `.env` **atau** langsung di cockpit (⚙ Settings → Telegram → *Test Telegram*).

---

## 4. Helius (opsional, free plan) — sangat disarankan

Tanpa Helius, bot memakai RPC publik Solana yang lambat & sering kena rate-limit:
- menganalisa 1 wallet whale ≈ **1–2 menit**,
- discovery whale baru jadi sangat pelan.

Dengan Helius, 1 wallet dianalisa dalam beberapa detik.

### Cara dapat key
1. Daftar akun gratis di **https://dashboard.helius.dev** (pilih plan **Free**).
2. Salin **API key** dari dashboard.
3. Isi ke `.env`:
   ```env
   HELIUS_API_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```
   Biarkan `SOLANA_RPC_URL` tetap default. Bot otomatis pindah ke RPC Helius kalau key-nya ada.

### Supaya tidak melebihi kuota gratis
Free plan punya batas kredit per bulan (lihat angkanya di dashboard Helius). Pemakaian bot terutama dari scanner:

```
panggilan per hari ≈ (86400 / scan interval detik) × jumlah whale aktif
contoh: interval 20s × 30 whale  ≈ 130.000 panggilan/hari
```

- Scanner sudah dibuat hemat: data detail transaksi hanya diambil kalau whale **benar-benar** punya transaksi baru.
- Pantau pemakaian di dashboard Helius minggu pertama.
- Kalau mendekati batas, naikkan **Scan interval** (misal 45–60 detik) di ⚙ Settings → Scanner, atau naikkan **Min win rate** supaya whale yang dipantau lebih sedikit.

---

## 5. Asisten AI "Fins" (opsional) — chat bebas lewat Telegram

Bot Telegram yang sama juga berfungsi sebagai asisten pribadi bernama **Fins**: catat keuangan, simpan password (vault terenkripsi), ingat percakapan lama, baca struk foto (OCR), jalankan sandbox Docker (shell/browse web), dan **tanya-jawab soal bot trading** (cari whale baru, daftar whale, posisi, profit/loss, saldo wallet, status API provider, halt/resume buy, lihat setting). Fins **tidak pernah** bisa eksekusi buy/sell/close posisi langsung dari chat — itu tetap lewat tombol approve/skip di cockpit.

Fitur ini jalan lokal lewat **LM Studio** (gratis, tanpa API key, data tidak keluar dari komputer kamu).

### a. Install & jalankan LM Studio
1. Download **LM Studio** dari https://lmstudio.ai dan install.
2. Di LM Studio, download model chat (contoh: `qwen/qwen3.5-9b`) dan model embedding (contoh: `text-embedding-nomic-embed-text-v1.5`).
3. Jalankan local server di LM Studio (Developer → Start Server), pastikan port-nya **1235** (atau sesuaikan `LMSTUDIO_BASE_URL` di `.env`).

### b. Batasi siapa yang boleh chat dengan Fins
Fins bisa membaca/ubah data keuangan pribadi, password vault, dan kontrol bot — jadi defaultnya **tertutup total** sampai diisi:
```env
ASSISTANT_ALLOWED_USER_ID="123456789"
```
Isi dengan Telegram user ID kamu sendiri (lihat cara ambil user ID di bagian 3b). Kalau kosong, fitur chat bebas & foto struk ini nonaktif (notifikasi trading tetap jalan normal).

### c. (Opsional) Sandbox Docker untuk shell/browse web
Kalau ingin Fins bisa jalankan command shell atau browsing web di sandbox terisolasi:
```bash
docker build -t finsassiant-sandbox -f docker/sandbox/Dockerfile.sandbox docker/sandbox
```
Sandbox jalan dengan `--cap-drop=ALL --security-opt=no-new-privileges`, tanpa akses filesystem host.

### d. Variabel `.env` terkait
```env
LMSTUDIO_BASE_URL="http://localhost:1235/v1"
LMSTUDIO_MODEL="qwen/qwen3.5-9b"
LMSTUDIO_EMBEDDING_MODEL="text-embedding-nomic-embed-text-v1.5"
ASSISTANT_ALLOWED_USER_ID="123456789"
```

---

## 6. Isi file `.env`

```bash
cp .env.example .env
```

Yang perlu diisi (sisanya biarkan default):

```env
# Telegram (bisa juga diisi di cockpit)
TELEGRAM_BOT_TOKEN="1234567890:AAH...xyz"
TELEGRAM_CHAT_ID="123456789"
TELEGRAM_ADMIN_IDS="123456789"

# Opsional tapi disarankan
HELIUS_API_KEY=""

# Biarkan PAPER dulu
PAPER_TRADING=true
```

Yang **tidak perlu** diisi:
- `SOLANA_PRIVATE_KEY`: bot membuat trading wallet sendiri (terenkripsi). Isi hanya kalau ingin memakai wallet yang sudah ada (lebih baik lewat `npm run wallet -- import <key>`).
- `SECRETS_KEY`: kalau kosong, bot membuat `.secrets/master.key` sendiri.
- `ALCHEMY_API_KEY`: tidak dipakai.
- `BIRDEYE_API_KEY`: opsional. Kalau diisi, dipakai sebagai sumber tambahan token trending (volume 24h) saat whale discovery — melebarkan jaring pencarian whale selain DexScreener.
- `WATCHED_WALLETS`: opsional; bot mencari whale sendiri. Isi hanya kalau ada wallet tertentu yang ingin dipantau.

---

## 7. Menjalankan

### Opsi A — Mac Studio 24/7 (disarankan, hemat daya)

Di Mac, bot dijalankan **native** (bukan Docker). Docker Desktop di macOS menjalankan VM Linux sendiri yang terus memakan CPU & RAM. Native jauh lebih hemat, dan Mac Studio idle hanya memakai sedikit daya dibanding PC desktop.

**Sekali jalan, semuanya otomatis:**
```bash
git clone <repo-kamu> ~/fins-trade && cd ~/fins-trade
./scripts/mac-setup.sh
```

Yang dilakukan script (aman dijalankan ulang kapan saja):

| Langkah | Detail |
|---|---|
| 1. Homebrew | Diinstall kalau belum ada (minta password Mac) |
| 2. Node 22, PostgreSQL 16, Redis | Via Homebrew, jalan sebagai service: auto-start dan auto-restart |
| 3. `.env` | Dibuat & diisi otomatis (DB, Redis); menanyakan Telegram, Helius, akses LAN (Enter = lewati) |
| 4. Dependencies & schema | `npm ci` + `prisma db push` |
| 5. Service launchd | `~/Library/LaunchAgents/com.finstrade.bot.plist`: bot start otomatis, restart sendiri kalau crash |
| 6. Power | `pmset`: sistem tidak pernah sleep (layar boleh mati), nyala sendiri setelah listrik padam |
| 7. Rotasi log | `newsyslog`: 10 MB × 7 file, supaya disk tidak penuh |
| 8. Ringkasan | Alamat cockpit, alamat wallet bot, password LAN |

Opsi: `--yes` (pakai semua default tanpa bertanya), `--no-power` (jangan ubah setting sleep).

**Kontrol sehari-hari:**
```bash
./scripts/fins.sh status     # service, postgres, redis, cockpit
./scripts/fins.sh logs       # live log
./scripts/fins.sh errors     # error/warning terakhir
./scripts/fins.sh restart
./scripts/fins.sh stop       # ⚠ posisi terbuka tidak dijaga selama bot mati
./scripts/fins.sh backup     # DB + .secrets + .env → ~/fins-trade-backups/<tanggal>
./scripts/fins.sh update     # git pull + install + migrate + restart
./scripts/fins.sh wallet     # alamat & saldo (wallet -- export untuk private key)
./scripts/fins.sh report     # LIVE readiness + file JSON untuk direview AI lain
```

**Membuka cockpit dari PC/HP lain:** jawab `y` saat ditanya *"Buka cockpit dari PC/HP lain"*. Script akan mengisi `HOST=0.0.0.0` dan membuat `COCKPIT_PASSWORD` acak. Buka `http://<ip-mac>:3000` dan login (username bebas, password dari ringkasan / `.env`). Bot **menolak start** kalau `HOST` dibuka ke jaringan tanpa password.

**Supaya benar-benar 24/7 setelah Mac restart:** service launchd baru jalan setelah user login. Ada dua pilihan:
- **Auto-login** (System Settings → Users & Groups → *Automatically log in as …*): bot jalan sendiri setelah listrik padam. Fitur ini **tidak tersedia kalau FileVault aktif**. Ini trade-off: tanpa FileVault, disk tidak terenkripsi kalau Mac dicuri.
- **FileVault tetap aktif**: setelah listrik padam, Mac menyala di layar login dan bot baru jalan setelah kamu login (bisa remote lewat Screen Sharing). Pasang UPS kecil supaya ini jarang terjadi.

**Pindah dari PC ke Mac:** kalau wallet bot di PC **belum diisi SOL**, tidak perlu apa-apa; Mac membuat wallet baru. Kalau sudah ada saldo:
```bash
# di PC
npm run wallet -- export          # salin private key
# di Mac, setelah mac-setup.sh
./scripts/fins.sh wallet import <private-key>
./scripts/fins.sh restart
```
Daftar whale yang sudah ditemukan di PC akan ditemukan ulang otomatis oleh discovery di Mac.

### Opsi B — Docker (Linux/PC)
```bash
docker compose up -d --build
docker compose logs -f bot
```

### Opsi C — Manual (development)
```bash
docker compose up -d postgres redis
npm install
npx prisma db push
npm start
```

Lalu buka cockpit: **http://127.0.0.1:3000**

---

## 8. Trading wallet & dana

Saat pertama kali jalan, bot membuat **wallet khusus trading** dan menampilkan alamatnya di cockpit (panel *Trading Wallet*) dan di log. Bisa juga dilihat dengan:
```bash
npm run wallet
```

**Penting:**
1. **Backup `.secrets/master.key`** (simpan di tempat aman, misalnya password manager). Tanpa file ini private key wallet tidak bisa dibuka lagi.
2. Ekspor private key untuk cadangan / menarik dana lewat Phantom atau Solflare:
   ```bash
   npm run wallet -- export
   ```
   Key hanya muncul di terminal, tidak pernah lewat web.
3. Pakai wallet ini **khusus untuk bot**. Isi hanya dana yang siap hilang.
4. Bot selalu menyisakan `SOL reserve` (default 0.02 SOL) untuk biaya transaksi.

---

## 9. Checklist sebelum LIVE

> Cockpit punya panel **Live readiness** yang mengecek sebagian besar poin di bawah secara otomatis: jumlah trade, PnL setelah biaya, profit tanpa trade terbaik, drawdown, uptime, sell gagal, dan Telegram. Untuk second opinion: **Copy report for AI** (atau `./scripts/fins.sh report`) lalu tempel bersama [`prompts/live-readiness-review.md`](prompts/live-readiness-review.md) ke AI lain.


- [ ] Bot sudah jalan beberapa hari di **PAPER** mode
- [ ] Ada whale berstatus **QUALIFIED** di *Whale Radar*
- [ ] *Equity Curve* & *Score vs Outcome* di cockpit sudah dinilai, threshold sudah disesuaikan
- [ ] Telegram terhubung (*Test Telegram* berhasil) dan `TELEGRAM_ADMIN_IDS` sudah diisi
- [ ] `.secrets/master.key` sudah di-backup, `npm run wallet -- export` sudah dicoba
- [ ] Ukuran posisi, max posisi terbuka, dan max spend/24 jam sudah diatur di ⚙ Settings
- [ ] Kalau *Strategy 2 (dip reversal)* dinyalakan: hasil paper-nya sudah dinilai terpisah di KPI *Dip strategy*, dan `dipEntrySol` + `solReserve` sudah pas dengan saldo wallet
- [ ] SOL sudah dikirim ke alamat trading wallet
- [ ] ⚙ Settings → matikan *Paper trading* → ketik `LIVE` → Save

Tombol **⏻ HALT BUYS** di cockpit menghentikan semua pembelian baru seketika. Posisi yang sudah ada tetap dijaga stop-loss/take-profit.

---

## 10. Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| Whale Radar lama kosong | Normal di awal; discovery tiap 60 menit dan RPC publik lambat. Pasang Helius, atau klik ⚡ *Discover now*. |
| Log: `Telegram not configured` | Token/chat ID kosong atau formatnya salah. Isi di ⚙ Settings lalu *Test Telegram*. |
| Log: `deleteWebhook failed (404)` | Token Telegram salah. Buat ulang/salin lagi dari @BotFather. |
| `BUYS HALTED` | Circuit breaker: ≥3 stop-loss dalam 60 menit, atau HALT ditekan. Otomatis normal lagi setelah jendela 60 menit, atau klik *RESUME BUYS*. |
| `insufficient balance` di Decision Log | Saldo SOL kurang dari ukuran posisi + reserve. Isi SOL atau kecilkan ukuran posisi. |
| `No Jupiter route` | Token terlalu baru/tipis atau Jupiter sedang gangguan. Sinyal akan dilewati (aman). |
| Scanner dip tidak pernah menemukan apa pun | Normal kalau pasar sedang naik semua (tidak ada yang oversold). Kalau log berisi `no candles for any candidate`, sumber candle tidak bisa diakses — cek `GECKOTERMINAL_API_BASE` atau isi `BIRDEYE_API_KEY` sebagai fallback. Longgarkan `dipRsiOversold` / `dipMinNarrativeScore` kalau terlalu ketat. |
| Cockpit tidak bisa dibuka dari HP/komputer lain | Default hanya `127.0.0.1`. Di Mac: jalankan ulang `./scripts/mac-setup.sh` dan jawab `y` untuk akses LAN (butuh password), atau pakai SSH tunnel: `ssh -L 3000:127.0.0.1:3000 user@mac-studio.local`. |
| Bot berhenti setelah Mac restart | Belum login (lihat *auto-login* di bagian Mac Studio). Cek `./scripts/fins.sh status`. |
| Mac masih sleep | Cek `pmset -g` → `sleep` harus `0`. Jalankan ulang `mac-setup.sh` tanpa `--no-power`. |
