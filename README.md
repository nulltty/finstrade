# 🐟 Fins Trade — Whale-Signal Meme Coin Autopilot (Solana)

Bot 24/7 yang **mencari sendiri** wallet whale yang terbukti profit di meme coin, memantau apa yang mereka beli berikutnya, menjalankan semua cek keamanan dari [Blueprint](Blueprint_%20Whale-Signal%20Trading%20Bot.html), lalu **otomatis beli/jual** dan mengirim notifikasi Telegram. Kamu cukup mengisi SOL ke trading wallet bot.

> ⚠️ Ini mengeksekusi transaksi on-chain nyata dengan uang nyata. Skor keamanan **bukan prediksi harga**; token yang lolos semua cek tetap bisa turun ke nol, dan win rate whale di masa lalu tidak menjamin hasil berikutnya. Default-nya **PAPER mode** — jalankan beberapa hari, nilai hasilnya di cockpit, baru aktifkan LIVE dengan dana yang siap hilang.

---

## Alur otomatis

```
 Discovery (tiap 60m)                       Scanner (tiap 20s)
 DexScreener trending winners  ─┐           wallet whale aktif ──► swap BUY baru?
 RugCheck top holders + traders ├─► Profiler ──► qualified?          │            │
 Re-profile whale lama          ┘   (PnL realised,   ya → dipantau     │            └─ whale SELL token yang kita pegang
                                     win rate, bot filter)             ▼               → COPY-SELL otomatis
                                                         Aggregator: DexScreener + GoPlus + RugCheck + Jupiter sim
                                                                      ▼
                                                  Scoring Engine (bobot blueprint + hard-fail)
                                                                      ▼  skor ≥ threshold & semua cek lolos
                                  AUTOPILOT: risk gates → BUY via Jupiter → notif Telegram
                                  (mode APPROVAL: [Approve]/[Skip] seperti blueprint)
                                                                      ▼
                                  Position Monitor (15s): −SL% → auto sell · +TP% → trailing stop / auto sell
```

### Cara bot memilih whale ("selalu profit")
Tidak ada daftar whale hardcode. Kandidat diambil dari pemegang/trader token yang sedang naik tajam, lalu **riwayat swap on-chain tiap wallet dianalisa** (`src/services/walletProfiler.ts`):
- PnL realised per token (proceeds − cost × porsi terjual), win rate, rata-rata hold time
- Lolos jika: closed trades ≥ `minWhaleClosedTrades`, win rate ≥ `minWhaleWinRate`, PnL > 0, rata-rata buy ≥ 0.3 SOL
- Ditolak: bot/sniper/MEV (hold < 2 menit atau ratusan tx per jam), exchange, pool, locker, insider
- Whale aktif di-profile ulang tiap 12 jam dan otomatis di-pause kalau performanya turun

### Cek keamanan sebelum beli (blueprint §2.3 + tambahan)
| Cek | Sumber | Hard fail |
|---|---|---|
| Honeypot: freeze authority, balance-mutable, non-transferable, transfer fee ≥10% | GoPlus + RugCheck | ✅ |
| **Simulasi jual**: tidak ada route jual / round-trip loss > batas | Jupiter quote | ✅ |
| Price impact untuk ukuran posisi kita > batas | Jupiter quote | ✅ |
| Data kontrak tidak bisa diambil dari sumber manapun | — | ✅ |
| Likuiditas unlocked & < $5K | RugCheck/DexScreener | ✅ |
| Token sudah rugged | RugCheck | ✅ |
| LP locked/burned %, top-10 holder (pool & locker dikecualikan), mint authority, vol/MC, umur, holders, insider networks | semua | skor berbobot |

### Risk gates sebelum BUY
Circuit breaker (≥3 stop-loss/60 menit), max posisi terbuka, max spend 24 jam, tidak beli token yang sudah dipegang, sinyal basi (> `maxSignalAgeSec`) dilewati, SOL reserve untuk fee.

---

## Menjalankan

> 📋 Panduan lengkap (API key gratis, Telegram, Mac Studio 24/7): **[setup.md](setup.md)**
>
> Mac Studio: cukup `./scripts/mac-setup.sh`, semuanya diinstall & dijadikan service otomatis.

```bash
docker compose up -d postgres redis
cp .env.example .env        # opsional: HELIUS_API_KEY, Telegram
npm install
npx prisma db push
npm start                   # cockpit: http://127.0.0.1:3000
```

Atau 24/7 sepenuhnya di Docker (restart otomatis):
```bash
docker compose up -d --build
```

### Langkah setelah start
1. Saat start pertama bot membuat **trading wallet khusus** (key terenkripsi AES-256-GCM di DB; master key di `.secrets/master.key` — **backup file ini**). Alamatnya tampil di cockpit dan log.
2. Isi Telegram bot token + chat ID di **⚙ Settings** → *Test Telegram*.
3. Biarkan PAPER mode berjalan; pantau *Equity Curve* dan *Score vs Outcome*.
4. Siap live: kirim SOL ke alamat trading wallet → Settings → matikan *Paper trading* (ketik `LIVE` untuk konfirmasi).

### Wallet CLI (key hanya tampil di terminal, tidak pernah lewat web)
```bash
npm run wallet               # alamat + saldo
npm run wallet -- export     # private key → import ke Phantom/Solflare untuk tarik dana
npm run wallet -- import <key>
```

### Sangat disarankan: Helius API key
Tanpa `HELIUS_API_KEY`, bot memakai RPC publik Solana yang lambat & rate-limited — discovery dan scanning jadi jauh lebih pelan. Free tier Helius sudah cukup.

---

## Keamanan
- Cockpit hanya listen di `127.0.0.1` (bisa mengubah setting & menjual posisi). Jangan expose tanpa auth.
- Semua POST butuh header `x-cockpit` (proteksi CSRF dari website lain di browser yang sama).
- Webhook Helius wajib header `Authorization: <WEBHOOK_SECRET>`.
- Sinyal simulasi (`⚗ Simulate`) selalu paper, bahkan di mode LIVE.
- Setiap keputusan otomatis tercatat di `audit_logs` dan tampil di *Decision Log*.
- Tombol **⏻ HALT BUYS** menghentikan semua pembelian baru seketika (posisi yang ada tetap dijaga SL/TP).

## Test
```bash
npm test
```
