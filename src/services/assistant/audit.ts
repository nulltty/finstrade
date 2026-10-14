import fs from 'fs';
import { assistantDataPath } from './paths.js';

const SENSITIVE_KEYS = new Set(['password']);

export function logToolCall(chatId: number | string | undefined, fnName: string, args: Record<string, any>, result: string) {
  const safeArgs: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) safeArgs[k] = SENSITIVE_KEYS.has(k) ? '***REDACTED***' : v;
  const safeResult = fnName === 'retrieve_credential' ? '***REDACTED***' : String(result).slice(0, 200);

  const entry = { ts: Date.now() / 1000, chat_id: chatId, tool: fnName, args: safeArgs, result_preview: safeResult };
  fs.appendFileSync(assistantDataPath('audit.log'), JSON.stringify(entry) + '\n');
}
