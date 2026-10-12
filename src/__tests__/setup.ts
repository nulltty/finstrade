import { execSync } from 'child_process';
import dotenv from 'dotenv';

export default function setup() {
  // Create / sync the isolated test schema before any suite runs
  const base = process.env.DATABASE_URL || dotenv.config({ quiet: true }).parsed?.DATABASE_URL || '';
  const url = base.replace(/schema=[^&"]+/, 'schema=test');
  execSync('npx prisma db push --skip-generate', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: url } });
}
