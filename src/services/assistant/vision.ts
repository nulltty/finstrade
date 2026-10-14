import { getLlmClient } from './llmClient.js';
import { env } from '../../config/index.js';

const EXTRACT_PROMPT = `Baca struk belanja ini dengan teliti. Balas HANYA JSON valid (tanpa markdown),
format: {"merchant": str, "date": "YYYY-MM-DD atau null", "total": number, "items": [{"name": str, "price": number}]}.
Kalau ada field yang tidak terbaca jelas, isi null. Jangan mengarang data yang tidak ada di gambar.`;

interface ReceiptData {
  merchant?: string;
  date?: string | null;
  total?: number;
  items?: Array<{ name: string; price: number }>;
  error?: string;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /\{[\s\S]*\}/.exec(trimmed);
  return match ? match[0] : trimmed;
}

export async function extractReceipt(imageBytes: Buffer): Promise<ReceiptData> {
  const b64 = imageBytes.toString('base64');
  const client = getLlmClient();
  const resp = await client.chat.completions.create({
    model: env.LMSTUDIO_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: EXTRACT_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      },
    ] as any,
  });
  const raw = resp.choices[0].message.content || '';
  try {
    return JSON.parse(stripCodeFence(raw));
  } catch {
    return { error: 'Gagal baca struk, coba foto ulang yang lebih jelas.' };
  }
}
