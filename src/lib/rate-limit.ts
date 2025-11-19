/**
 * Rate Limiting
 *
 * Redis-backed rate limiter using sliding window algorithm.
 * Designed for Vercel serverless functions.
 */

import { kv } from "./kv.js";
import { cfg } from "./env.js";
import { errorLog } from "./logger.js";

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in the window */
  remaining: number;
  /** Unix timestamp when the window resets */
  resetAt: number;
}

/**
 * Default rate limit configurations
 */
export const RATE_LIMITS = {
  /** Per-IP rate limit for public endpoints */
  perIp: {
    limit: 100,
    windowSeconds: 60,
  },
} as const;

/**
 * Check rate limit for a given identifier
 * Uses sliding window counter algorithm
 */
export async function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - config.windowSeconds;
  const key = `${cfg.prefix}ratelimit:${identifier}`;

  try {
    const client = await kv.getClient();

    // Use Redis sorted set with timestamps as scores
    // Remove old entries and count current window in one transaction
    const multi = client.multi();

    // Remove entries outside the window
    multi.zRemRangeByScore(key, 0, windowStart);

    // Count entries in current window
    multi.zCard(key);

    // Add current request
    multi.zAdd(key, { score: now, value: `${now}:${Math.random()}` });

    // Set expiry on the key
    multi.expire(key, config.windowSeconds);

    const results = await multi.exec();

    // zCard result is at index 1
    const zCardResult = results?.[1];
    const count = typeof zCardResult === 'number' ? zCardResult : 0;

    const allowed = count < config.limit;
    const remaining = Math.max(0, config.limit - count - 1);
    const resetAt = now + config.windowSeconds;

    return {
      allowed,
      remaining,
      resetAt,
    };
  } catch (err) {
    // On Redis error, allow the request but log the error
    // This prevents rate limiting from blocking all requests if Redis is down
    errorLog("Rate limit check failed", err);
    return {
      allowed: true,
      remaining: config.limit,
      resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
    };
  }
}

/**
 * Get client IP from Vercel request headers
 */
export function getClientIp(headers: Record<string, string | string[] | undefined>): string {
  // Vercel provides the real IP in x-forwarded-for
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return ip.trim();
  }

  // Fallback to x-real-ip
  const realIp = headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  return "unknown";
}

/**
 * Set rate limit headers on response
 */
export function setRateLimitHeaders(
  res: { setHeader: (name: string, value: string | number) => void },
  result: RateLimitResult,
  config: RateLimitConfig
): void {
  res.setHeader("X-RateLimit-Limit", config.limit);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  res.setHeader("X-RateLimit-Reset", result.resetAt);
}
