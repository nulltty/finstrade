import OpenAI from 'openai';
import { env } from '../../config/index.js';

/** OpenAI-compatible client pointed at the local LM Studio server — no real API key needed. */
export function getLlmClient(): OpenAI {
  return new OpenAI({ baseURL: env.LMSTUDIO_BASE_URL, apiKey: 'not-needed' });
}

export async function embed(text: string): Promise<number[]> {
  const client = getLlmClient();
  const res = await client.embeddings.create({ model: env.LMSTUDIO_EMBEDDING_MODEL, input: text });
  return res.data[0].embedding;
}
