import { describe, it, expect, beforeAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Point the assistant's sqlite-backed tools at a throwaway temp dir so these tests never
// touch the real personal finance/vault data under assistant/data/.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fins-assistant-test-'));
process.env.ASSISTANT_DATA_DIR = tmpDir;

let financeTools: typeof import('../services/assistant/financeTools.js');
let vaultTools: typeof import('../services/assistant/vaultTools.js');

beforeAll(async () => {
  financeTools = await import('../services/assistant/financeTools.js');
  vaultTools = await import('../services/assistant/vaultTools.js');
});

describe('Assistant finance tools', () => {
  it('records an expense and reflects it in the monthly summary', () => {
    const msg = financeTools.addExpense({ amount: 25000, category: 'makan' });
    expect(msg).toContain('Rp25.000');
    expect(msg).toContain('makan');

    const summary = financeTools.getSummary({ period: 'all' });
    expect(summary).toContain('Pengeluaran');
  });

  it('records income separately from expenses', () => {
    financeTools.addIncome({ amount: 100000, category: 'gaji' });
    const summary = financeTools.getSummary({ period: 'all' });
    expect(summary).toContain('Pemasukan');
    expect(summary).toContain('Pengeluaran');
  });
});

describe('Assistant vault tools', () => {
  it('round-trips an encrypted credential', () => {
    vaultTools.storeCredential({ service: 'wifi rumah', password: 'sangat-rahasia', username: 'admin' });
    const result = vaultTools.retrieveCredential({ service: 'wifi rumah' });
    expect(result).toContain('sangat-rahasia');
    expect(result).toContain('admin');
  });

  it('lists stored service names without exposing passwords', () => {
    vaultTools.storeCredential({ service: 'email', password: 'another-secret' });
    const list = vaultTools.listServices();
    expect(list).toContain('wifi rumah');
    expect(list).toContain('email');
    expect(list).not.toContain('another-secret');
  });

  it('reports no credential for an unknown service', () => {
    const result = vaultTools.retrieveCredential({ service: 'tidak-ada' });
    expect(result).toContain('Tidak ada password');
  });
});
