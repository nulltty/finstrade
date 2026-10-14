import { env } from '../config/index.js';
import { prisma } from '../db/prisma.js';
import { logger } from './logger.js';

const HELIUS_WEBHOOKS_BASE = 'https://api.helius.xyz/v0/webhooks';

/**
 * Pushes the current list of active Solana whale addresses to Helius, so the webhook
 * keeps tracking whoever we're actually watching. This is an optimization on top of the
 * scanner poller — if it fails or HELIUS_WEBHOOK_ID isn't set, we just log and move on.
 */
export async function syncWebhookAddresses() {
  if (!env.HELIUS_WEBHOOK_ID || !env.HELIUS_API_KEY) return;

  try {
    const wallets = await prisma.watchedWallet.findMany({
      where: { isActive: true, chain: 'solana' },
      select: { address: true },
    });
    const accountAddresses = wallets.map((w) => w.address);

    const res = await fetch(`${HELIUS_WEBHOOKS_BASE}/${env.HELIUS_WEBHOOK_ID}?api-key=${env.HELIUS_API_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: env.HELIUS_WEBHOOK_URL,
        transactionTypes: ['SWAP'],
        accountAddresses,
        webhookType: 'enhanced',
        authHeader: env.WEBHOOK_SECRET,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status, text: await res.text() }, 'Helius webhook sync failed');
      return;
    }
    logger.info({ count: accountAddresses.length }, 'Helius webhook address list synced');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Helius webhook sync error');
  }
}
