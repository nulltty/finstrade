import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/index.js';
import { logger } from './logger.js';

const SECRETS_DIR = path.join(process.cwd(), '.secrets');
const MASTER_KEY_FILE = path.join(SECRETS_DIR, 'master.key');
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte master key: SECRETS_KEY env wins, otherwise a key file
 * is generated once under .secrets/ (gitignored, chmod 600).
 */
function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  let material = env.SECRETS_KEY;
  if (!material) {
    if (fs.existsSync(MASTER_KEY_FILE)) {
      material = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    } else {
      material = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(MASTER_KEY_FILE, material, { mode: 0o600 });
      logger.warn({ file: MASTER_KEY_FILE }, 'Generated new master key for wallet encryption — back this file up');
    }
  }

  cachedKey = crypto.scryptSync(material, 'whalebot-wallet-v1', 32);
  return cachedKey;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return !!value && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored; // legacy plaintext value
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
