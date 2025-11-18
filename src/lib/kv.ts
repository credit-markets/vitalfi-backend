/**
 * Vercel KV (Redis) Client
 *
 * Uses the redis package with REDIS_URL for Vercel KV storage.
 * Provides helpers for JSON storage and namespacing.
 */

import { createClient } from "redis";
import { cfg } from "./env.js";
import { errorLog } from "./logger.js";
import { PING_INTERVAL_MS } from "./constants.js";

// Global Redis client instance
let redis: ReturnType<typeof createClient> | null = null;
let connecting: Promise<void> | null = null;
let lastPingTime = 0;

/**
 * Get or create Redis client (singleton pattern for serverless)
 */
async function getClient() {
  // If client exists and is open, trust isOpen flag on fast path
  // Only ping if we haven't verified connection health recently
  if (redis?.isOpen) {
    const now = Date.now();
    const needsPing = now - lastPingTime > PING_INTERVAL_MS;

    if (needsPing) {
      try {
        await redis.ping();
        lastPingTime = now;
        return redis;
      } catch (err) {
        errorLog('Redis ping failed, reconnecting', err);
        // Gracefully close the old connection to prevent socket leaks
        await redis.quit().catch((quitErr) => {
          errorLog('Failed to close stale Redis connection', { error: quitErr });
        });
        redis = null;
        connecting = null;
        lastPingTime = 0;
      }
    } else {
      // Fast path: skip ping, trust isOpen
      return redis;
    }
  }

  // If currently connecting, wait for that connection
  if (connecting) {
    await connecting;
    if (!redis) {
      throw new Error('Redis connection failed');
    }
    return redis;
  }

  // Create new client
  redis = createClient({ url: cfg.redisUrl });
  redis.on('error', (err) => errorLog('Redis Client Error', err));

  // Clean up on connection end (for serverless environments)
  redis.on('end', () => {
    redis = null;
    connecting = null;
  });

  // Connect
  connecting = redis.connect().then(() => {
    connecting = null;
    lastPingTime = Date.now(); // Mark connection as healthy
  }).catch((err) => {
    connecting = null;
    redis = null;
    lastPingTime = 0;
    throw err;
  });

  await connecting;
  if (!redis) {
    throw new Error('Redis connection failed');
  }
  return redis;
}

// Export for direct access if needed
export const kv = { getClient };

/**
 * Execute multiple Redis operations in a single round-trip using MULTI/EXEC
 * This is true Redis pipelining - all operations are sent together and executed atomically
 *
 * @param callback Function that receives a pipeline builder and adds commands
 * @returns Array of results from each command
 *
 * @example
 * await pipeline(async (pipe) => {
 *   pipe.set('key1', 'value1');
 *   pipe.zAdd('key2', { score: 1, value: 'member' });
 *   pipe.sAdd('key3', 'member');
 * });
 */
export async function pipeline(
  callback: (pipe: ReturnType<ReturnType<typeof createClient>['multi']>) => void
): Promise<unknown[]> {
  const client = await getClient();
  const multi = client.multi();
  callback(multi);
  return multi.exec();
}

/**
 * Helper to build prefixed key for pipeline operations
 */
export function prefixKey(key: string): string {
  return `${cfg.prefix}${key}`;
}

/**
 * Get JSON value from KV
 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const value = await client.get(prefixedKey);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    errorLog(`Failed to parse JSON for key ${prefixedKey}`, err);
    return null;
  }
}

/**
 * Set JSON value in KV
 */
export async function setJSON(
  key: string,
  value: unknown,
  opts?: { ex?: number }
): Promise<void> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const stringValue = JSON.stringify(value);
  if (opts?.ex) {
    await client.set(prefixedKey, stringValue, { EX: opts.ex });
  } else {
    await client.set(prefixedKey, stringValue);
  }
}

/**
 * Add member to set
 */
export async function sadd(key: string, ...members: string[]): Promise<number> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const result = await client.sAdd(prefixedKey, members);
  return typeof result === 'number' ? result : 0;
}

/**
 * Get all members of a set
 */
export async function smembers(key: string): Promise<string[]> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  return client.sMembers(prefixedKey);
}

/**
 * Add member to sorted set with score
 */
export async function zadd(
  key: string,
  score: number,
  member: string
): Promise<number> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const result = await client.zAdd(prefixedKey, { score, value: member });
  return result ?? 0;
}

/**
 * Remove member from sorted set
 */
export async function zrem(key: string, ...members: string[]): Promise<number> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const result = await client.zRem(prefixedKey, members);
  return result ?? 0;
}

/**
 * Get members from sorted set by score range (reverse order: max to min)
 */
export async function zrevrangebyscore(
  key: string,
  max: number | string,
  min: number | string,
  opts?: { offset?: number; count?: number }
): Promise<string[]> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;

  // Use zRangeByScore with REV option for reverse score-based range query
  const options: { REV: boolean; LIMIT?: { offset: number; count: number } } = { REV: true };
  if (opts) {
    options.LIMIT = {
      offset: opts.offset ?? 0,
      count: opts.count ?? -1,
    };
  }

  const results = await client.zRangeByScore(prefixedKey, min, max, options);
  return results;
}

/**
 * Check if key exists
 */
export async function exists(key: string): Promise<boolean> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const result = await client.exists(prefixedKey);
  return result === 1;
}

/**
 * Set key only if it doesn't exist (returns 1 if set, 0 if already exists)
 * Supports optional TTL in seconds
 */
export async function setnx(
  key: string,
  value: unknown,
  opts?: { ex?: number }
): Promise<number> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const stringValue = JSON.stringify(value);

  if (opts?.ex) {
    // Use SET with NX and EX options for atomic operation
    const result = await client.set(prefixedKey, stringValue, {
      NX: true,
      EX: opts.ex,
    });
    return result === "OK" ? 1 : 0;
  } else {
    const result = await client.setNX(prefixedKey, stringValue);
    return result ? 1 : 0;
  }
}
