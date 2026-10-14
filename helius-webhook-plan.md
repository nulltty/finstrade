# Planning — Helius Webhook (deteksi whale real-time) + Named Tunnel Permanen

Status: **sedang dipantau** (tunnel sementara, belum permanen). Dokumen ini dibuat supaya kalau
sesi chat/agent putus, progress & rencana lanjutannya tidak hilang.

---

## 1. Kenapa ini dikerjakan

Selisih harga entry whale vs entry bot (contoh: whale masuk $0.0006176, bot masuk $0.0006527,
+5.7%) sebagian berasal dari delay deteksi: scanner polling tiap N detik, bukan real-time.
Helius mendukung webhook push — begitu transaksi whale konfirmasi on-chain, Helius langsung
`POST` ke endpoint kita (biasanya <1 detik), jauh lebih cepat dari polling.

Dua perbaikan lain yang **sudah selesai & live** (tidak dibahas lagi di sini):
- `autoScanIntervalSec` 20s → 10s (lantai minimum yang diizinkan kode)
- Timeout RugCheck di `aggregator.ts` 12s → 6s (biar RugCheck lambat nggak nahan seluruh proses)

---

## 2. Status saat ini (test, per 14 Okt 2026)

- Endpoint webhook sudah ada di kode sejak awal: `POST /api/webhook/helius` di
  `src/dashboard/server.ts`, dilindungi header `Authorization` yang harus match `WEBHOOK_SECRET`
  (`.env`). Tidak ada perubahan kode untuk bagian ini — murni setup eksternal.
- **Tunnel sementara** (`cloudflared tunnel --url http://127.0.0.1:8890`) dijalankan manual di
  background (nohup), log di `/tmp/cloudflared.log` & `/tmp/cloudflared.out`.
  URL yang di-generate waktu ini dibuat: `https://favorites-structure-downloads-push.trycloudflare.com`
  — **URL ini acak dan akan beda tiap kali tunnel di-restart.**
- Webhook sudah didaftarkan ke Helius lewat API mereka (`POST /v0/webhooks`):
  - `webhookID: 242b004b-2736-49bf-a1a8-a4170d8fb09e`
  - `webhookType: enhanced`, `transactionTypes: ["SWAP"]`
  - `accountAddresses`: snapshot 9 whale aktif saat pendaftaran (lihat §4, daftar ini **statis**,
    tidak otomatis update kalau whale baru ditemukan).
  - `authHeader` di Helius diisi sama dengan `WEBHOOK_SECRET` kita, supaya endpoint kita menerima.
- **Scanner polling (10s) tetap jalan** sebagai jalur utama/fallback. Webhook cuma jalur
  tambahan — kalau webhook & scanner sama-sama nangkep tx yang sama, dedup `txHash` yang sudah
  ada di `watcher.ts` otomatis cuma proses sekali. Jadi aman walau kedua jalur aktif bersamaan.
- **Belum ada kode baru ditambahkan untuk semua ini** — semuanya hasil panggilan API eksternal
  (Helius, Cloudflare) dari terminal, bukan perubahan ke repo.

### Risiko kondisi saat ini (karena masih tunnel sementara)
- Kalau sesi shell yang menjalankan `cloudflared` mati (restart Mac, tunnel di-kill, dsb),
  webhook Helius akan menunjuk ke URL yang sudah mati. **Tidak ada downtime trading** karena
  scanner poller tetap jalan normal — cuma balik ke speed deteksi lama (10s), bukan error.
- Daftar address di webhook **tidak sinkron otomatis** dengan whale baru dari auto-discovery.

---

## 3. Yang mau dipantau dulu (sebelum lanjut ke bagian permanen)

Bandingkan, untuk sinyal yang masuk setelah webhook aktif:
- Apakah sinyal lebih cepat terdeteksi lewat webhook dibanding scanner? (bisa dicek dari log:
  cari baris `New whale signal recorded` dan lihat apakah muncul tanpa menunggu siklus scanner
  10s berikutnya — atau tambahkan sumber ke log kalau perlu dibedakan nanti)
- Apakah ada error dari Helius (misal karena tunnel sempat putus)?
- Apakah selisih harga whale-vs-bot pada sinyal baru lebih kecil dari contoh sebelumnya (+5.7%)?

---

## 4. Rencana lanjutan — kalau hasil pemantauan positif

### A. Sinkronisasi otomatis daftar address webhook

**Masalah**: webhook Helius punya daftar `accountAddresses` statis (snapshot waktu didaftarkan).
Kalau whale baru ditemukan (auto-discovery) atau whale di-nonaktifkan, daftar ini harus
diperbarui manual lewat API Helius (`PUT /v0/webhooks/{webhookID}`), kalau tidak whale baru
nggak akan pernah kebagian deteksi real-time (cuma kebagian scanner, balik ke speed lama buat
whale itu saja).

**Rencana implementasi** (file baru `src/services/heliusWebhook.ts`):
- `HELIUS_WEBHOOK_ID` disimpan di `.env` (hasil pendaftaran awal — nanti harus didaftarkan ulang
  kalau pindah ke named tunnel, ID baru harus diupdate di `.env`).
- Fungsi `syncWebhookAddresses()`:
  1. Ambil semua `watchedWallet` yang `isActive: true, chain: 'solana'`.
  2. `PATCH`/`PUT` ke `https://api.helius.xyz/v0/webhooks/{HELIUS_WEBHOOK_ID}` dengan
     `accountAddresses` terbaru (plus field lain yang wajib dikirim ulang: `webhookURL`,
     `transactionTypes`, `webhookType`, `authHeader` — API Helius biasanya minta full payload,
     bukan partial patch, perlu dicek dokumentasi `PUT` endpoint mereka).
  3. Helius punya limit jumlah address per webhook (periksa limit akun — kalau whale aktif makin
     banyak dari limit, perlu strategi split jadi beberapa webhook atau prioritaskan whale
     ber-skor tertinggi).
- Panggil `syncWebhookAddresses()` dari:
  - `whaleDiscovery` tiap kali wallet baru diaktifkan/dinonaktifkan (`discovery.ts`).
  - Endpoint manual tambah/hapus wallet di cockpit (`POST/DELETE /api/wallets` di `server.ts`).
  - Opsional: job terjadwal tiap beberapa menit sebagai pengaman tambahan (in case ada
    perubahan status yang nggak lewat jalur di atas).
- Tangani kegagalan API Helius dengan log warning saja (jangan sampai gagal sync bikin
  discovery/aktivasi wallet gagal juga) — webhook itu optimasi, bukan jalur kritis.

### B. Pindah dari tunnel sementara ke named tunnel (domain kamu)

**Kenapa perlu**: tunnel sementara (`trycloudflare.com`) URL-nya acak & berubah tiap restart,
nggak cocok buat 24/7. Named tunnel pakai domain kamu, URL tetap selamanya, dan bisa dijadikan
service launchd yang auto-restart kalau Mac reboot — sama seperti pattern service bot utama.

**Langkah (butuh akun Cloudflare + domain kamu sudah masuk Cloudflare DNS)**:
1. `cloudflared tunnel login` — buka browser, authorize ke akun Cloudflare, pilih domain.
2. `cloudflared tunnel create fins-trade-webhook` — generate tunnel ID + credentials file
   (biasanya di `~/.cloudflared/<tunnel-id>.json`).
3. `cloudflared tunnel route dns fins-trade-webhook webhook.<domain-kamu>` — bikin DNS record
   otomatis (CNAME ke tunnel), jadi URL permanennya misal `https://webhook.domainkamu.com`.
4. Config file `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: fins-trade-webhook
   credentials-file: /Users/wardana/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: webhook.domainkamu.com
       service: http://127.0.0.1:8890
     - service: http_status:404
   ```
5. Bikin launchd plist baru (`com.finstrade.cloudflared.plist`), pola persis seperti
   `com.finstrade.bot.plist` yang sudah ada — `RunAtLoad`, `KeepAlive`, restart otomatis kalau
   crash. Tambahkan juga ke `scripts/fins.sh status`/`restart` kalau mau dikontrol dari script
   yang sama dengan bot utama.
6. Setelah URL permanen jalan, **daftarkan ulang webhook Helius** (bikin webhook baru atau update
   `webhookURL` yang lama via API) ke `https://webhook.domainkamu.com/api/webhook/helius`, lalu
   matikan/hapus tunnel sementara dan webhook test (`242b004b-2736-49bf-a1a8-a4170d8fb09e`) biar
   nggak ada webhook nganggur nyoba kirim ke URL mati.
7. Catat `HELIUS_WEBHOOK_ID` yang baru di `.env`, update `setup.md` dengan langkah-langkah ini
   supaya bisa direproduksi kalau pindah mesin lagi (pola yang sama seperti bagian Mac Studio di
   `setup.md`).

### C. Hal yang masih perlu diputuskan user sebelum eksekusi bagian B
- Domain mana yang dipakai (subdomain `webhook.`?) dan apakah domain itu sudah di-point ke
  Cloudflare nameserver (kalau belum, perlu pindah NS dulu — di luar kendali bot).
- Apakah mau tunnel ini jalan sebagai service terpisah (launchd sendiri) atau digabung start-nya
  dengan `./scripts/fins.sh` (start/stop/restart sekaligus).

---

## 5. Checklist ringkas kalau lanjut nanti

- [ ] Hasil pemantauan: webhook benar-benar lebih cepat dari scanner, tidak ada error berulang
- [ ] Implementasi `heliusWebhook.ts` + wiring auto-sync (bagian A)
- [ ] Setup named tunnel dengan domain (bagian B, langkah 1–5)
- [ ] Daftar ulang webhook Helius ke URL permanen, hapus webhook test lama (bagian B, langkah 6)
- [ ] Update `.env` (`HELIUS_WEBHOOK_ID`) dan `setup.md` (bagian B, langkah 7)
- [ ] Matikan proses `cloudflared` tunnel sementara yang jalan manual sekarang (cek `ps aux | grep cloudflared`)
