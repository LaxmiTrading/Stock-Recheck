/**
 * Rate limiting for sensitive endpoints — specification section 34.
 *
 * A fixed-window counter kept in Postgres. This is deliberately simple: the
 * request volumes here are modest and a database-backed limiter works
 * correctly across concurrent serverless instances without adding Redis.
 */

import { createHash } from 'node:crypto';
import { query } from './database/client';
import { RateLimitedError } from './errors';
import { logInfo } from './http';

export interface RateLimitRule {
  /** Distinct name so different endpoints get separate buckets. */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Login is the highest-value target for credential stuffing. */
export const LOGIN_RATE_LIMIT: RateLimitRule = { name: 'login', limit: 10, windowSeconds: 300 };
export const PASSWORD_RESET_RATE_LIMIT: RateLimitRule = {
  name: 'password_reset',
  limit: 5,
  windowSeconds: 900,
};
/** Validation fans out to Zoho, so it is throttled per user. */
export const IMPORT_VALIDATION_RATE_LIMIT: RateLimitRule = {
  name: 'import_validate',
  limit: 20,
  windowSeconds: 300,
};
export const CLAIM_RATE_LIMIT: RateLimitRule = { name: 'claim', limit: 120, windowSeconds: 60 };
export const EXPORT_RATE_LIMIT: RateLimitRule = { name: 'export', limit: 30, windowSeconds: 300 };

/** Hashed so raw IPs and emails are not stored in the limiter table. */
function bucketKey(rule: RateLimitRule, identifier: string): string {
  const digest = createHash('sha256').update(`${rule.name}:${identifier}`).digest('hex');
  return `${rule.name}:${digest.slice(0, 32)}`;
}

function windowStart(windowSeconds: number, now = Date.now()): Date {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now / windowMs) * windowMs);
}

/**
 * Records one hit and throws `RateLimitedError` once the limit is exceeded.
 *
 * Fails OPEN: if the limiter's own query errors we allow the request through
 * rather than taking the whole application down. The failure is logged.
 */
export async function enforceRateLimit(
  rule: RateLimitRule,
  identifier: string,
  correlationId: string,
): Promise<void> {
  const key = bucketKey(rule, identifier);
  const start = windowStart(rule.windowSeconds);

  let hitCount: number;
  try {
    const result = await query<{ hit_count: number }>(
      `INSERT INTO rate_limits (bucket_key, window_start, hit_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (bucket_key, window_start)
       DO UPDATE SET hit_count = rate_limits.hit_count + 1
       RETURNING hit_count`,
      [key, start],
    );
    hitCount = result.rows[0]?.hit_count ?? 0;
  } catch (error) {
    logInfo('ratelimit.unavailable', {
      correlationId,
      rule: rule.name,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return;
  }

  if (hitCount > rule.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((start.getTime() + rule.windowSeconds * 1000 - Date.now()) / 1000),
    );
    logInfo('ratelimit.exceeded', { correlationId, rule: rule.name, hitCount });
    throw new RateLimitedError(retryAfterSeconds);
  }
}

/** Housekeeping: drops windows that can no longer be hit. */
export async function pruneRateLimits(): Promise<void> {
  await query("DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 hours'");
}
