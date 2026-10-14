import { DatabaseSync } from 'node:sqlite';
import { assistantDataPath } from './paths.js';

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(assistantDataPath('finance.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
      amount REAL NOT NULL,
      category TEXT,
      note TEXT,
      receipt_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

const today = () => new Date().toISOString().slice(0, 10);
const idr = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;

export function addExpense(args: { amount: number; category: string; note?: string; date?: string; receipt_path?: string }): string {
  const d = args.date || today();
  getDb()
    .prepare('INSERT INTO transactions (date, type, amount, category, note, receipt_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d, 'expense', args.amount, args.category, args.note || '', args.receipt_path || null);
  return `Tercatat: keluar ${idr(args.amount)} untuk ${args.category} (${d})`;
}

export function addIncome(args: { amount: number; category: string; note?: string; date?: string }): string {
  const d = args.date || today();
  getDb()
    .prepare('INSERT INTO transactions (date, type, amount, category, note) VALUES (?, ?, ?, ?, ?)')
    .run(d, 'income', args.amount, args.category, args.note || '');
  return `Tercatat: masuk ${idr(args.amount)} dari ${args.category} (${d})`;
}

export function getSummary(args: { period?: 'today' | 'month' | 'all' }): string {
  const period = args.period || 'month';
  const where =
    period === 'month'
      ? "strftime('%Y-%m', date) = strftime('%Y-%m', 'now')"
      : period === 'today'
        ? "date = date('now')"
        : '1=1';

  const rows = getDb()
    .prepare(`SELECT type, SUM(amount) as total FROM transactions WHERE ${where} GROUP BY type`)
    .all() as Array<{ type: string; total: number }>;

  if (!rows.length) return 'Belum ada transaksi di periode ini.';
  return rows
    .map((r) => `${r.type === 'income' ? 'Pemasukan' : 'Pengeluaran'}: ${idr(r.total)}`)
    .join(' | ');
}

export const FINANCE_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'add_expense',
      description: 'Catat pengeluaran/belanja',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Jumlah dalam Rupiah' },
          category: { type: 'string', description: 'Kategori, misal: makan, transport' },
          note: { type: 'string' },
          date: { type: 'string', description: 'Format YYYY-MM-DD, kosongkan jika hari ini' },
        },
        required: ['amount', 'category'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_income',
      description: 'Catat pemasukan',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          category: { type: 'string' },
          note: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['amount', 'category'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_summary',
      description: 'Lihat ringkasan keuangan pribadi untuk periode tertentu',
      parameters: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['today', 'month', 'all'] } },
        required: ['period'],
      },
    },
  },
];

export const FINANCE_TOOL_FUNCTIONS: Record<string, (args: any) => string> = {
  add_expense: addExpense,
  add_income: addIncome,
  get_summary: getSummary,
};
