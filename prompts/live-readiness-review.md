# Prompt: Review Kelayakan LIVE Trading — Fins Trade

> **Cara pakai**
> 1. Ambil report terbaru, pilih salah satu:
>    - Cockpit → panel **Live readiness** → **Copy report for AI** (atau **Download report**)
>    - Di Mac/server: `./scripts/fins.sh report` → file `reports/fins-trade-readiness-<tanggal>.json`
> 2. Buka AI lain (ChatGPT, Gemini, Claude, dll). Salin **semua teks di bawah garis**, lalu tempel isi JSON di tempat `<<<TEMPEL JSON DI SINI>>>`.
> 3. Kalau JSON terlalu panjang untuk chat, lampirkan sebagai file dan ganti placeholder dengan "lihat file terlampir".
>
> Report **tidak** berisi private key, token Telegram, atau alamat wallet lengkap, jadi aman dibagikan ke AI.

---

Kamu adalah **risk reviewer kuantitatif yang skeptis**. Tugasmu memutuskan apakah bot trading meme coin saya sudah layak berpindah dari **paper trading** (simulasi) ke **live trading** (uang asli). Bias-mu harus ke arah **"belum"**: kalau ragu, jawab belum. Kehilangan peluang jauh lebih murah daripada kehilangan modal.

## Konteks bot

- **Fins Trade** memantau wallet "whale" di Solana yang punya riwayat profit di meme coin. Saat whale membeli token baru, bot memeriksa keamanan token (likuiditas, LP lock, holder, mint/freeze authority, simulasi jual via Jupiter), memberi skor 0–100, lalu otomatis membeli kalau skor ≥ threshold.
- Exit: stop-loss otomatis, take-profit lalu trailing stop, dan *copy-sell* saat whale menjual.
- **Paper fill itu optimistis.** BUY diisi pada harga DexScreener saat sinyal dinilai, SELL pada harga yang dilihat monitor tiap 15 detik. Tidak ada slippage, fee swap, priority fee, transaksi gagal, atau delay antara whale membeli dan bot membeli.
- Field `adj*` sudah dikurangi *haircut* per trade untuk mendekati biaya nyata (lihat `haircut.pct` dan `haircut.source`). Field tanpa `adj` adalah hasil mentah paper.

## Data

Berikut report JSON dari bot (field penting: `checks`, `paperSummary`, `trades`, `exitReasons`, `qualifiedWhales`, `settings`, `rules`, `haircut`, `engines`, `auditActions30d`):

```json
<<<TEMPEL JSON DI SINI>>>
```

## Yang harus kamu lakukan

Kerjakan langkah demi langkah dan **tunjukkan angkanya**. Hitung sendiri dari array `trades`, jangan hanya mengutip `checks`/`paperSummary`. Kalau hasilmu berbeda dari angka bot, sebutkan.

1. **Integritas data**
   - Berapa trade paper yang benar-benar tertutup? Rentang tanggalnya? Ada celah waktu panjang tanpa trade (bot mati)?
   - Ada keanehan: PnL ekstrem (> +500% atau tepat −100%), hold time 0 menit, harga entry 0, trade duplikat token yang sama berdekatan?
   - Apakah `engines` menunjukkan error berulang atau uptime pendek?

2. **Edge setelah biaya**
   - Rata-rata `adjPnlPct` per trade dan median-nya. Median jauh di bawah rata-rata berarti hasil ditopang sedikit trade besar.
   - **Uji ketahanan biaya:** hitung ulang ekspektasi dengan haircut tambahan **+3%** dan **+6%** per trade. Apakah masih positif?
   - Total `adjPnlUsd` **tanpa 1 trade terbaik** dan **tanpa 3 trade terbaik**.
   - Profit factor (total win ÷ |total loss|) setelah biaya.
   - Perkiraan kasar ketidakpastian: rata-rata `adjPnlPct` ± 2 × (standar deviasi / √n). Apakah batas bawahnya > 0?
   - Win rate dengan interval kepercayaan 95% (Wilson).

3. **Stabilitas**
   - Bandingkan paruh pertama dan paruh kedua trade (urut waktu). Apakah performa menurun?
   - Konsentrasi per whale (field `whale`): apakah > 50% profit datang dari satu whale?
   - Konsentrasi per token: apakah ada token yang dibeli berkali-kali?

4. **Filter & exit**
   - Apakah skor memprediksi hasil? Kelompokkan trade per rentang `score` (mis. <80, 80–89, ≥90) dan bandingkan `adjPnlPct`.
   - Per `exitReason`: berapa jumlah dan rata-rata hasilnya? Apakah stop-loss terlalu sering kena? Apakah trailing stop menyerahkan terlalu banyak profit?
   - Apakah `whale_exit` (copy-sell) membantu atau merugikan?

5. **Risiko**
   - Max drawdown pada equity yang sudah disesuaikan biaya, dalam USD dan dalam kelipatan ukuran posisi rata-rata.
   - Losing streak terpanjang.
   - Dengan `settings` sekarang (`tradeAmountUsd`, `maxOpenPositions`, `maxDailySpendUsd`, `stopLossPercent`), berapa kerugian terburuk yang realistis dalam satu hari buruk?
   - Ada setting yang janggal? Contoh: `maxDailySpendUsd` terlalu besar dibanding ukuran trade, slippage terlalu longgar, threshold terlalu rendah.

6. **Cek bot sendiri**
   - Tinjau `checks`. Untuk setiap check berstatus `fail` atau `pending`, jelaskan artinya dan apa yang harus dilakukan.
   - Check berstatus `manual` (backup master key) harus saya konfirmasi sendiri. Ingatkan saya.

## Aturan keputusan

Pilih **satu** verdict:

- **❌ NOT READY**: salah satu: ekspektasi setelah biaya ≤ 0; profit hilang tanpa trade terbaik; ada sell yang gagal; drawdown > 1.5× ukuran posisi; atau data menunjukkan bug.
- **⏳ KEEP COLLECTING**: tidak ada tanda buruk yang jelas, tapi trade < 30, periode < 14 hari, batas bawah ketidakpastian ≤ 0, atau hasil tidak tahan haircut tambahan +3%.
- **✅ READY FOR SMALL LIVE TEST**: semua cek otomatis lolos, ekspektasi tetap positif dengan haircut +3%, profit tidak bergantung pada 1–3 trade, stabil antar paruh periode, tidak terkonsentrasi pada satu whale.

Bahkan dengan ✅, rekomendasikan **uji live kecil**, bukan live penuh: ukuran per trade kecil (gunakan `recommendedFirstLive` sebagai acuan atau lebih kecil), max 2 posisi, cap harian rendah, selama ±2 minggu. Setelah itu bandingkan hasil live vs paper sebelum menaikkan ukuran.

## Format jawaban

Jawab dalam **Bahasa Indonesia**, dengan struktur ini:

1. **Verdict:** ❌ / ⏳ / ✅ + satu kalimat alasan utama
2. **Angka kunci** (tabel): jumlah trade, periode, win rate (CI 95%), rata-rata & median adjPnl%, ekspektasi dengan haircut +3% dan +6%, total tanpa trade terbaik, profit factor, max drawdown, losing streak
3. **Temuan positif** (maks 5 poin)
4. **Red flags** (urut dari paling serius), masing-masing dengan angka pendukung
5. **Yang harus dilakukan sebelum review berikutnya** (konkret: setting apa diubah ke nilai berapa, berapa trade lagi ditunggu)
6. **Kalau ✅:** setting live awal yang disarankan + kondisi berhenti (mis. "kembali ke paper kalau rugi > $X atau 5 stop-loss beruntun")
7. **Kapan review lagi** (tanggal atau jumlah trade)

Jangan memberi saran investasi umum atau memprediksi harga token. Nilai hanya berdasarkan data di report. Kalau data tidak cukup untuk menjawab sesuatu, katakan terus terang.
