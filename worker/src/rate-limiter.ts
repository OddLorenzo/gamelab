import { DurableObject } from 'cloudflare:workers';

export const RATE_WINDOW_MS = 60_000;

export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Fixed-window counter, one instance per route class and client (idFromName(`${bucket}:${ipKey}`),
 * see limits.ts); the limit comes with each hit().
 * Storage holds the window start and the count; an alarm at window end deletes
 * everything so idle IPs leave nothing behind. The timestamp comparison in
 * hit() also resets a window whose alarm has not fired yet.
 */
export class RateLimiter extends DurableObject<Cloudflare.Env> {
  async hit(limit: number): Promise<RateDecision> {
    const now = Date.now();
    let start = (await this.ctx.storage.get<number>('start')) ?? 0;
    let count = (await this.ctx.storage.get<number>('count')) ?? 0;

    if (start === 0 || now - start >= RATE_WINDOW_MS) {
      start = now;
      count = 0;
      await this.ctx.storage.put('start', start);
      await this.ctx.storage.setAlarm(start + RATE_WINDOW_MS);
    }

    if (count >= limit) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((start + RATE_WINDOW_MS - now) / 1000)) };
    }
    await this.ctx.storage.put('count', count + 1);
    return { ok: true };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
