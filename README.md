# 🐟 Fins Trade — Meme Coin Autopilot (Solana)

Bot 24/7 dengan **dua strategi** yang jalan berdampingan di satu bot, berbagi wallet, safety engine, dan cockpit yang sama:

1. **Whale copy-trade** (default) — **mencari sendiri** wallet whale yang terbukti profit di meme coin, memantau apa yang mereka beli berikutnya, menjalankan semua cek keamanan dari [Blueprint](Blueprint_%20Whale-Signal%20Trading%20Bot.html), lalu **otomatis beli/jual**.
2. **RSI dip reversal** (opsional) — **scan sendiri** meme coin yang kondisinya sehat tapi sedang oversold dan mulai naik lagi, cek narasinya, masuk dengan ukuran SOL tetap, lalu ambil profit beberapa dolar per trade.

Semua keputusan dinotifikasi ke Telegram. Kamu cukup mengisi SOL ke trading wallet bot.

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

## Strategy 2 — RSI dip reversal (scalp konsisten)

Default **mati**. Nyalakan di ⚙ Settings → *STRATEGY 2 — RSI DIP REVERSAL* → *Aktifkan scanner dip*.

```
 Dip scanner (tiap 5 menit, default)
 DexScreener boosts/profiles + Birdeye trending
          │
          ▼  filter pasar: liq ≥ $50K · vol24h ≥ $150K · umur ≥ 24 jam
          │  penurunan 24 jam < 45% · buy/sell 1 jam ≥ 1 · belum dipegang & tidak cooldown
          ▼  candle 15m (GeckoTerminal, fallback Birdeye)
 RSI(14) pernah ≤ 35 · sekarang naik lagi (≥ low + 2 poin) · masih ≤ 50
 harga sudah +0.5% dari low · EMA21 tidak jatuh jauh di bawah EMA50 · volume masih hidup
          ▼
 Cek narasi (0–100): kategori narasi (AI/politik/animal/culture/…) + sosial + boost + keyword kamu
          ▼  ≥ 45
 Safety engine yang sama dengan sinyal whale (honeypot, LP lock, top-10, simulasi jual)
 — tapi price impact & simulasi jual diukur untuk ukuran order kita yang sebenarnya (0.3 SOL)
          ▼  score ≥ 70
 BUY 0.3 SOL  →  TP $4–$5 bersih  ·  SL −30%
```

### Kenapa bukan "RSI < 30 → beli"
RSI rendah adalah yang dicetak koin yang sedang jatuh bebas, sepanjang jalan turun. Jadi yang dicari
bukan cuma oversold, tapi **oversold yang sudah mulai berbalik** di koin yang sebelum dip-nya sehat:
RSI harus pernah menyentuh zona oversold, sekarang naik lagi tapi belum pulih, harga sudah lepas dari
low-nya, tren panjang belum rusak, dan pool-nya masih diperdagangkan. Kalau ada satu saja yang tidak
lolos, token dilewati — dan setiap cek beserta angkanya tercatat di *Safety inspector* cockpit.

### Take-profit $4–$5: dihitung dari harga jual nyata
Target profit absolut hanya masuk akal kalau yang dihitung adalah uang yang benar-benar bisa ditarik.
Begitu profit mendekati target, bot minta **quote jual Jupiter untuk seluruh posisi** dan mengurangi
fee swap keluar — bukan memakai harga mid DexScreener. Lalu:

| Kondisi | Aksi |
|---|---|
| Profit bersih ≥ $5 (*stretch*) | jual sekarang |
| Profit bersih ≥ $4 **dan harga masih bikin high baru** | ditahan dulu (badge `RIDING` di cockpit) |
| Profit bersih ≥ $4 **dan momentum berhenti** | jual — ini jalur normalnya |
| Sudah pernah ≥ $4 lalu turun di bawah ~$3.4 | jual, amankan sisanya |
| −30% dari entry | stop-loss otomatis |

Karena itu `dipMaxPriceImpactPct` default **1,5%** (bukan 5% seperti pipeline whale): price impact 5%
pada entry ~$60 sudah memakan habis target $4-nya.

### Risiko & pembatas
- Posisi dip punya slot sendiri (`dipMaxOpenPositions`, default 3) **di dalam** `maxOpenPositions` global,
  jadi scanner tidak bisa menghabiskan semua slot bot.
- Ukuran 0.3 SOL tidak pernah dikecilkan diam-diam: kalau saldo tidak cukup (termasuk `solReserve`),
  entry dibatalkan dan alasannya masuk Decision Log — posisi separuh tidak akan pernah sampai target $4.
- Circuit breaker, cooldown per token (default 120 menit), max spend 24 jam, dan HALT BUYS berlaku untuk
  kedua strategi.
- Cockpit memisahkan hasil per strategi (KPI *Dip strategy*), jadi pipeline whale yang profit tidak bisa
  menutupi scanner dip yang merugi — atau sebaliknya.
- Semua di atas **bukan prediksi harga**, hanya filter. Ukuran 0.3 SOL per posisi memang kecil karena ini
  eksperimen yang boleh gagal. Jalankan di PAPER dulu dan nilai hasilnya di cockpit.

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
