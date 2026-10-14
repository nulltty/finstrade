import { DatabaseSync } from 'node:sqlite';
import { assistantDataPath } from './paths.js';
import { embed } from './llmClient.js';

// Simple embedded vector memory (sqlite + cosine similarity in JS) replacing the original
// Python prototype's ChromaDB — fine at this scale (one user, a few thousand messages) and
// avoids depending on a separate vector DB server/binary from Node.
let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(assistantDataPath('memory.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      ts REAL NOT NULL
    )
  `);
  return db;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function saveMessage(chatId: number | string, role: string, text: string): Promise<void> {
  if (!text) return;
  const vec = await embed(text);
  getDb()
    .prepare('INSERT INTO messages (chat_id, role, text, embedding, ts) VALUES (?, ?, ?, ?, ?)')
    .run(String(chatId), role, text, JSON.stringify(vec), Date.now());
}

export async function recall(chatId: number | string, query: string, topK = 3): Promise<string[]> {
  const rows = getDb()
    .prepare('SELECT text, embedding FROM messages WHERE chat_id = ?')
    .all(String(chatId)) as Array<{ text: string; embedding: string }>;
  if (!rows.length) return [];

  const queryVec = await embed(query);
  const scored = rows.map((r) => ({ text: r.text, score: cosine(queryVec, JSON.parse(r.embedding)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.text);
}
