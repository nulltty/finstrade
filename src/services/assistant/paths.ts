import path from 'path';
import fs from 'fs';

// Reuses the data directory from the original Python prototype (assistant/data/) so the
// existing finance.db rows and vault.key aren't lost in the TypeScript port. Overridable via
// env for tests, so they don't write into the real personal finance/vault data.
export const ASSISTANT_DATA_DIR = process.env.ASSISTANT_DATA_DIR || path.join(process.cwd(), 'assistant', 'data');

export function assistantDataPath(file: string): string {
  fs.mkdirSync(ASSISTANT_DATA_DIR, { recursive: true });
  return path.join(ASSISTANT_DATA_DIR, file);
}
