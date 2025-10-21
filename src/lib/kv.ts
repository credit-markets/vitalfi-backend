/**
 * Vercel KV (Redis) Client
 *
 * Uses the redis package with REDIS_URL for Vercel KV storage.
 * Provides helpers for JSON storage and namespacing.
 */

import { createClient } from "redis";
import { cfg } from "./env.js";

// Global Redis client instance
let redis: ReturnType<typeof createClient> | null = null;
let connecting: Promise<void> | null = null;

/**
 * Get or create Redis client (singleton pattern for serverless)
 */
async function getClient() {
  // If client exists and is open, return it
  if (redis?.isOpen) {
    return redis;
  }

  // If currently connecting, wait for that connection
  if (connecting) {
    await connecting;
    return redis!;
  }

  // Create new client
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', (err) => console.error('Redis Client Error:', err));

  // Connect
  connecting = redis.connect().then(() => {
    connecting = null;
  }).catch((err) => {
    connecting = null;
    redis = null;
    throw err;
  });

  await connecting;
  return redis!;
}

// Export for direct access if needed
export const kv = { getClient };

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
  } catch {
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
 * Get members from sorted set by score range
 */
export async function zrevrangebyscore(
  key: string,
  max: number | string,
  min: number | string,
  opts?: { offset?: number; count?: number }
): Promise<string[]> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const limit = opts ? { offset: opts.offset ?? 0, count: opts.count ?? -1 } : undefined;
  // Use zRange with REV option for reverse order (max to min)
  const results = await client.zRange(prefixedKey, max, min, {
    BY: 'SCORE',
    REV: true,
    LIMIT: limit
  });
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
 */
export async function setnx(key: string, value: unknown): Promise<number> {
  const client = await getClient();
  const prefixedKey = `${cfg.prefix}${key}`;
  const stringValue = JSON.stringify(value);
  const result = await client.setNX(prefixedKey, stringValue);
  return result ? 1 : 0;
}
