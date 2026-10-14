import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const run = promisify(execFile);

const CONTAINER_NAME = 'fin-sandbox';
const IMAGE_NAME = 'finsassiant-sandbox';

async function isRunning(): Promise<boolean> {
  try {
    const { stdout } = await run('docker', ['ps', '--filter', `name=^${CONTAINER_NAME}$`, '--format', '{{.Names}}']);
    return stdout.includes(CONTAINER_NAME);
  } catch {
    return false;
  }
}

async function ensureRunning(): Promise<void> {
  if (await isRunning()) return;
  await run('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => {});
  await run('docker', [
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--memory=1g', '--cpus=1',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    IMAGE_NAME,
  ]);
}

export async function runShellCommand(args: { command: string; timeout?: number }): Promise<string> {
  await ensureRunning();
  try {
    const { stdout, stderr } = await run('docker', ['exec', CONTAINER_NAME, 'sh', '-c', args.command], {
      timeout: (args.timeout || 30) * 1000,
    });
    const output = (stdout + stderr).trim();
    return output ? output.slice(0, 4000) : '(tidak ada output)';
  } catch (err: any) {
    if (err.killed) return `Command timeout setelah ${args.timeout || 30} detik.`;
    return (((err.stdout || '') + (err.stderr || '')).trim() || err.message).slice(0, 4000);
  }
}

export async function browseWeb(args: { url: string }): Promise<string> {
  await ensureRunning();
  try {
    const { stdout } = await run('docker', ['exec', CONTAINER_NAME, 'python3', '/sandbox/browse.py', args.url], {
      timeout: 30000,
    });
    return stdout.trim().slice(0, 3000);
  } catch (err: any) {
    if (err.killed) return 'Timeout saat membuka URL.';
    return `Gagal akses URL: ${String(err.stderr || err.message).slice(0, 500)}`;
  }
}

export async function browseWebScreenshot(args: { url: string }): Promise<{ text: string; imageBuffer?: Buffer }> {
  await ensureRunning();
  try {
    await run('docker', ['exec', CONTAINER_NAME, 'python3', '/sandbox/browse.py', args.url, 'screenshot'], {
      timeout: 30000,
    });
    const tmpPath = path.join(os.tmpdir(), `fins-screenshot-${randomBytes(6).toString('hex')}.png`);
    await run('docker', ['cp', `${CONTAINER_NAME}:/sandbox/screenshot.png`, tmpPath]);
    const imageBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return { text: `Screenshot dari ${args.url} berhasil diambil.`, imageBuffer };
  } catch (err: any) {
    if (err.killed) return { text: 'Timeout saat mengambil screenshot.' };
    return { text: `Gagal mengambil screenshot: ${String(err.stderr || err.message).slice(0, 500)}` };
  }
}

export const SANDBOX_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_shell_command',
      description: 'Jalankan command shell di sandbox terisolasi (bukan host asli)',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browse_web',
      description: 'Buka halaman web dan ambil isi teksnya',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browse_web_screenshot',
      description: 'Buka halaman web dan ambil screenshot full-page-nya, lalu kirim sebagai gambar',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

export const SANDBOX_TOOL_FUNCTIONS: Record<
  string,
  (args: any) => Promise<string | { text: string; imageBuffer?: Buffer }>
> = {
  run_shell_command: runShellCommand,
  browse_web: browseWeb,
  browse_web_screenshot: browseWebScreenshot,
};
