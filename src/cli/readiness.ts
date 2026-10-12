/**
 * LIVE readiness report (works headless, e.g. on the Mac Studio over SSH)
 *   npm run readiness           → summary + writes reports/fins-trade-readiness-<date>.json
 * Give the JSON + prompts/live-readiness-review.md to any AI for a second opinion.
 */
import fs from 'fs';
import path from 'path';
import { connectDb, disconnectDb } from '../db/prisma.js';
import { buildReadinessReport } from '../services/readiness.js';

const ICON = { pass: '✓', fail: '✗', pending: '…', manual: '?' } as const;
const VERDICT = {
  not_ready: 'NOT READY — fix the failed checks first',
  collecting: 'COLLECTING DATA — keep paper trading',
  ready_small: 'READY FOR A SMALL LIVE TEST',
} as const;

async function main() {
  await connectDb();
  // Uptime belongs to the running service, not this CLI process
  const port = process.env.PORT || '3000';
  const uptimeSec = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json() as Promise<{ uptime: number }>)
    .then((j) => j.uptime)
    .catch(() => null);
  const report = await buildReadinessReport({ uptimeSec });
  const dir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `fins-trade-readiness-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  console.log(`\nFins Trade — LIVE readiness: ${VERDICT[report.verdict as keyof typeof VERDICT]}\n`);
  for (const c of report.checks) {
    console.log(`  ${ICON[c.status]} ${c.label.padEnd(44)} ${c.value.padEnd(34)} target ${c.target}`);
  }
  console.log(`\nReport: ${file}`);
  console.log('Second opinion: give this file + prompts/live-readiness-review.md to another AI.\n');
  await disconnectDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err.message);
  await disconnectDb();
  process.exit(1);
});
