import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { settingsService } from './settings.js';
import { logger } from './logger.js';

export class CircuitBreakerService {
  private isManuallyTripped = false;
  private tripReason = '';
  private resetAt = 0;

  /**
   * Check if circuit breaker allows new BUY orders
   */
  async canExecuteBuy(): Promise<{ allowed: boolean; reason?: string }> {
    if (this.isManuallyTripped) {
      return { allowed: false, reason: `Manually tripped: ${this.tripReason}` };
    }

    // If manually reset recently, allow buying
    if (this.resetAt && Date.now() - this.resetAt < 60000) {
      return { allowed: true };
    }

    const windowStart = new Date(Date.now() - env.CIRCUIT_BREAKER_WINDOW_MINUTES * 60 * 1000);

    // Count recent stop loss exits in the mode we are actually protecting. Counting both
    // together let live losses from an earlier session halt a paper run, and would let paper
    // experiments halt real trading. Archived history is excluded for the same reason it is
    // hidden from the cockpit: it belongs to a run that no longer describes current behaviour.
    const settings = await settingsService.getSettings();
    const recentStopLossCount = await prisma.position.count({
      where: {
        exitReason: 'stop_loss',
        isPaper: settings.paperTrading,
        archived: false,
        closedAt: { gte: windowStart },
      },
    });

    if (recentStopLossCount >= env.MAX_CONSECUTIVE_STOP_LOSS) {
      const msg = `Circuit breaker tripped: ${recentStopLossCount} stop-losses in last ${env.CIRCUIT_BREAKER_WINDOW_MINUTES}m (limit: ${env.MAX_CONSECUTIVE_STOP_LOSS})`;
      logger.error(msg);

      await prisma.auditLog.create({
        data: {
          action: 'CIRCUIT_BREAKER_TRIPPED',
          reason: msg,
          payload: { recentStopLossCount, windowStart },
        },
      });

      return { allowed: false, reason: msg };
    }

    return { allowed: true };
  }

  trip(reason: string) {
    this.isManuallyTripped = true;
    this.tripReason = reason;
    logger.warn({ reason }, 'Circuit breaker tripped manually');
  }

  reset() {
    this.isManuallyTripped = false;
    this.tripReason = '';
    this.resetAt = Date.now();
    logger.info('Circuit breaker manually reset');
  }

  getStatus() {
    return {
      isTripped: this.isManuallyTripped,
      tripReason: this.tripReason,
      maxConsecutiveStopLoss: env.MAX_CONSECUTIVE_STOP_LOSS,
      windowMinutes: env.CIRCUIT_BREAKER_WINDOW_MINUTES,
    };
  }
}

export const circuitBreaker = new CircuitBreakerService();
