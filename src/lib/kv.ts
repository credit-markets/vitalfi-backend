/**
 * Vercel KV (Redis) Client
 *
 * Wraps @vercel/kv with helpers for JSON storage and namespacing.
 */

import { kv as vercelKv } from "@vercel/kv";
import { cfg } from "./env.js";

export const kv = vercelKv;

/**
 * Get JSON value from KV
 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const prefixedKey = `${cfg.prefix}${key}`;
  const value = await kv.get<T>(prefixedKey);
  return value;
}

/**
 * Set JSON value in KV
 */
export async function setJSON(
  key: string,
  value: unknown,
  opts?: { ex?: number }
): Promise<void> {
  const prefixedKey = `${cfg.prefix}${key}`;
  if (opts?.ex) {
    await kv.set(prefixedKey, value, { ex: opts.ex });
  } else {
    await kv.set(prefixedKey, value);
  }
}

/**
 * Add member to set
 */
export async function sadd(key: string, ...members: string[]): Promise<number> {
  const prefixedKey = `${cfg.prefix}${key}`;
  // @ts-expect-error Upstash types may not have complete overloads for variadic args
  const result = await kv.sadd(prefixedKey, ...members);
  return typeof result === 'number' ? result : 0;
}

/**
 * Get all members of a set
 */
export async function smembers(key: string): Promise<string[]> {
  const prefixedKey = `${cfg.prefix}${key}`;
  return kv.smembers(prefixedKey);
}

/**
 * Add member to sorted set with score
 */
export async function zadd(
  key: string,
  score: number,
  member: string
): Promise<number> {
  const prefixedKey = `${cfg.prefix}${key}`;
  const result = await kv.zadd(prefixedKey, { score, member });
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
  const prefixedKey = `${cfg.prefix}${key}`;
  // @ts-expect-error Upstash types may not have complete overloads
  return kv.zrevrangebyscore(prefixedKey, max, min, opts);
}

/**
 * Check if key exists
 */
export async function exists(key: string): Promise<boolean> {
  const prefixedKey = `${cfg.prefix}${key}`;
  const result = await kv.exists(prefixedKey);
  return result === 1;
}

/**
 * Set key only if it doesn't exist (returns 1 if set, 0 if already exists)
 */
export async function setnx(key: string, value: unknown): Promise<number> {
  const prefixedKey = `${cfg.prefix}${key}`;
  return kv.setnx(prefixedKey, value);
}
