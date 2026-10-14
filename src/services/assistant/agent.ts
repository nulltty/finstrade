import { getLlmClient } from './llmClient.js';
import { env } from '../../config/index.js';
import { logToolCall } from './audit.js';

// Identity note: this agent IS Fins Trade's own bot — the same process that sends buy/sell/
// stop-loss notifications into this chat. That's stated explicitly so when the user asks
// "kenapa kamu beli itu" about a notification sent moments ago, the agent treats it as its
// own action instead of something an ambiguous third party did.
const SYSTEM_PROMPT = `Kamu bernama Fins — asisten pribadi DAN bot trading "Fins Trade" itu sendiri, keduanya satu
entitas yang sama, via Telegram.

Kepribadian: santai dan hangat seperti teman dekat yang enak diajak ngobrol, tapi tetap cerdas dan
kritis — jangan cuma manut, kalau ada keputusan atau angka yang kelihatan kurang masuk akal (misal
posisi yang rugi lama tidak di-cut, setting yang kelewat agresif, dll), tegur & kasih pendapat jujur.
Tidak usah terlalu formal atau kaku, tapi tetap rapi dan jelas.

Notifikasi otomatis (sinyal beli, auto-buy, stop-loss, take-profit, dll) yang muncul di chat ini
dikirim oleh DIRIMU SENDIRI (sistem trading), bukan pihak lain. Kalau user tanya soal notifikasi
itu, jawab sebagai pelaku, bukan pengamat (misal: "Saya beli karena skor whale-nya tinggi...", bukan
"bot itu membeli...").

Kamu bisa: catat keuangan pribadi, simpan password, ingat percakapan lama, DAN kontrol/cek status
trading bot (cari whale baru, lihat daftar whale, posisi, profit/loss, saldo wallet, status API
provider, hentikan/lanjutkan buy baru, lihat setting bot). Kamu TIDAK bisa & TIDAK AKAN pernah
eksekusi buy/sell/close posisi secara langsung dari chat — itu tetap lewat tombol approve/skip
yang sudah ada, demi keamanan dana live.

Jawab singkat, jelas, dalam Bahasa Indonesia.`;

export class Agent {
  lastToolCalls: string[] = [];

  constructor(
    private tools: Record<string, (args: any) => any>,
    private toolSpecs: any[]
  ) {}

  async run(userMessage: string, history: Array<{ role: string; content: string }> = [], chatId?: number | string, maxTurns = 5): Promise<string> {
    this.lastToolCalls = [];
    const client = getLlmClient();
    const messages: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: userMessage }];

    for (let i = 0; i < maxTurns; i++) {
      const resp = await client.chat.completions.create({
        model: env.LMSTUDIO_MODEL,
        messages,
        tools: this.toolSpecs.length ? this.toolSpecs : undefined,
      });
      const msg = resp.choices[0].message;

      if (!msg.tool_calls || !msg.tool_calls.length) {
        return msg.content || '';
      }

      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        this.lastToolCalls.push(fnName);
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }

        let result: string;
        if (!this.tools[fnName]) {
          result = `Error: tool '${fnName}' tidak ditemukan`;
        } else {
          try {
            result = String(await this.tools[fnName](args));
          } catch (err: any) {
            result = `Error saat eksekusi ${fnName}: ${err?.message || err}`;
          }
        }

        logToolCall(chatId, fnName, args, result);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    return 'Maaf, terlalu banyak langkah tanpa jawaban final.';
  }
}
