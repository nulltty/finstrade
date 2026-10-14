# Helius Webhook — deteksi whale real-time (DONE)

Status: **selesai, live di production (VPS).** Dokumen ini dipertahankan sebagai riwayat
keputusan, bukan lagi rencana aktif.

---

## 1. Kenapa ini dikerjakan

Selisih harga entry whale vs entry bot (contoh: whale masuk $0.0006176, bot masuk $0.0006527,
+5.7%) sebagian berasal dari delay deteksi: scanner polling tiap N detik, bukan real-time.
Helius mendukung webhook push — begitu transaksi whale konfirmasi on-chain, Helius langsung
`POST` ke endpoint kita (biasanya <1 detik), jauh lebih cepat dari polling.

Perbaikan lain yang sudah selesai & live di waktu yang sama:
- `autoScanIntervalSec` 20s → 10s
- Timeout RugCheck di `aggregator.ts` 12s → 6s

---

## 2. Arsitektur final

Bot pindah dari Mac Studio (tanpa IP publik) ke VPS (`fins.wrdna.cc`, IP publik asli). Karena
itu, **rencana named-tunnel Cloudflare di versi dokumen sebelumnya jadi tidak diperlukan** —
endpoint webhook langsung reachable publik lewat nginx + TLS (Let's Encrypt) di VPS, tanpa
tunnel apa pun.

- Endpoint: `POST /api/webhook/helius` (`src/dashboard/server.ts`), dilindungi header
  `Authorization` yang harus match `WEBHOOK_SECRET`.
- Webhook Helius terdaftar: `webhookID: 242b004b-2736-49bf-a1a8-a4170d8fb09e`,
  `webhookURL: https://fins.wrdna.cc/api/webhook/helius`, `webhookType: enhanced`,
  `transactionTypes: ["SWAP"]`.
- Scanner polling (10s) tetap jalan sebagai jalur utama/fallback. Webhook jalur tambahan —
  dedup `txHash` di `watcher.ts` memastikan tx yang sama (dari scanner maupun webhook) cuma
  diproses sekali.
- **Auto-sync address list** (`src/services/heliusWebhook.ts`, `syncWebhookAddresses()`):
  setiap ada perubahan wallet aktif (`addWallet`, `toggleWallet`, `deleteWallet`, atau akhir
  siklus auto-discovery di `discovery.ts`), daftar `accountAddresses` di webhook Helius
  otomatis di-`PUT` ulang. Gagal sync cuma di-log warning, tidak mengganggu jalur utama.
- Tunnel sementara Cloudflare yang dipakai waktu testing sudah dimatikan dan tidak dipakai lagi.

## 3. Env vars terkait

```
HELIUS_WEBHOOK_ID=242b004b-2736-49bf-a1a8-a4170d8fb09e
HELIUS_WEBHOOK_URL=https://fins.wrdna.cc/api/webhook/helius
```

(Keduanya disimpan di `.env` VPS. Kalau webhook pernah dihapus/dibuat ulang dari Helius
dashboard, update `HELIUS_WEBHOOK_ID` di sini juga.)
