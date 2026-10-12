import { prisma } from '../db/prisma.js';
import { logger } from './logger.js';

/** Persist an automated decision with its reason (blueprint §2.8 / Batch 9). Never throws. */
export async function audit(action: string, reason: string, payload?: Record<string, any>) {
  try {
    await prisma.auditLog.create({ data: { action, reason, payload: payload ?? undefined } });
  } catch (err: any) {
    logger.error({ action, err: err?.message }, 'Failed to write audit log');
  }
}
