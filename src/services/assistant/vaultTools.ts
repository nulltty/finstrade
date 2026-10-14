import fs from 'fs';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { assistantDataPath } from './paths.js';

let db: DatabaseSync | null = null;
let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyPath = assistantDataPath('vault.key');
  if (!fs.existsSync(keyPath)) {
    // Same format as the original Python prototype's Fernet key (url-safe base64, 32 raw bytes)
    // so a single key file keeps working across both implementations.
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('base64url'));
    fs.chmodSync(keyPath, 0o600);
  }
  const b64 = fs.readFileSync(keyPath, 'utf8').trim();
  cachedKey = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return cachedKey;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(assistantDataPath('vault.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      username TEXT,
      encrypted_password TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

export function storeCredential(args: { service: string; password: string; username?: string; note?: string }): string {
  const enc = encrypt(args.password);
  getDb()
    .prepare(
      `INSERT INTO credentials (service, username, encrypted_password, note) VALUES (?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET username=excluded.username,
         encrypted_password=excluded.encrypted_password, note=excluded.note`
    )
    .run(args.service, args.username || '', enc, args.note || '');
  return `Password untuk '${args.service}' sudah tersimpan aman.`;
}

export function retrieveCredential(args: { service: string }): string {
  const row = getDb().prepare('SELECT * FROM credentials WHERE service = ?').get(args.service) as any;
  if (!row) return `Tidak ada password tersimpan untuk '${args.service}'.`;
  const password = decrypt(row.encrypted_password);
  const usernamePart = row.username ? `Username: ${row.username}\n` : '';
  return `${usernamePart}Password: ${password}`;
}

export function listServices(): string {
  const rows = getDb().prepare('SELECT service FROM credentials').all() as Array<{ service: string }>;
  if (!rows.length) return 'Belum ada password tersimpan.';
  return rows.map((r) => r.service).join(', ');
}

export const VAULT_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'store_credential',
      description: 'Simpan password/credential untuk sebuah service secara terenkripsi',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Nama layanan, misal: wifi rumah, email' },
          password: { type: 'string' },
          username: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['service', 'password'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'retrieve_credential',
      description: 'Ambil kembali password yang tersimpan untuk sebuah service',
      parameters: {
        type: 'object',
        properties: { service: { type: 'string' } },
        required: ['service'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_services',
      description: 'Lihat daftar nama service yang passwordnya tersimpan (tanpa menampilkan password)',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const VAULT_TOOL_FUNCTIONS: Record<string, (args: any) => string> = {
  store_credential: storeCredential,
  retrieve_credential: retrieveCredential,
  list_services: listServices,
};

export const VAULT_TOOL_NAMES = new Set(Object.keys(VAULT_TOOL_FUNCTIONS));
