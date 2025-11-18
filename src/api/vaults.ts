/**
 * Vaults API
 *
 * GET /api/vaults?authority={pubkey}&status={status}&limit={N}
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { smembers, getJSON, zrevrangebyscore } from "../lib/kv.js";
import { json, error, handleCors } from "../lib/http.js";
import { kAuthorityVaults, kAuthorityVaultsByUpdated, kVaultJson } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { cfg } from "../lib/env.js";
import { logRequest, errorLog } from "../lib/logger.js";
import { isValidPubkey, cursorSchema } from "../lib/validation.js";
import { MAX_SET_SIZE, SET_WARNING_THRESHOLD } from "../lib/constants.js";
import { checkRateLimit, getClientIp, setRateLimitHeaders, RATE_LIMITS } from "../lib/rate-limit.js";
import { recordRequest } from "../lib/metrics.js";
import type { VaultDTO } from "../types/dto.js";

const QuerySchema = z.object({
  authority: z.string().min(32).max(44).refine(isValidPubkey, "Invalid Base58 public key"),
  status: z.enum(["Funding", "Active", "Matured", "Canceled"]).optional(),
  cursor: cursorSchema,
  limit: z.coerce.number().min(1).max(100).default(50),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  try {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return handleCors(res);
    }

    if (req.method !== "GET") {
      return error(res, 405, "Method not allowed");
    }

    // Check rate limit by IP
    const clientIp = getClientIp(req.headers as Record<string, string | string[] | undefined>);
    const rateLimitResult = await checkRateLimit(`ip:${clientIp}`, RATE_LIMITS.perIp);
    setRateLimitHeaders(res, rateLimitResult, RATE_LIMITS.perIp);

    if (!rateLimitResult.allowed) {
      const duration = Date.now() - start;
      logRequest("GET", "/api/vaults", 429, duration);
      recordRequest("/api/vaults", 429, duration, true);
      return error(res, 429, "Too many requests");
    }

    // Validate query params
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return error(res, 400, "Invalid query parameters", parsed.error.issues);
    }

    const { authority, status, cursor, limit } = parsed.data;

    // Use exclusive cursor to prevent duplicate items across pages
    // Redis ZREVRANGEBYSCORE supports exclusive ranges with parentheses: (score
    const maxScore = cursor !== undefined ? `(${cursor}` : '+inf';
    let pdas: string[];
    let usedZset = false;

    // Use per-status ZSET for filtered queries, or all vaults ZSET
    const zsetKey = status
      ? kAuthorityVaultsByUpdated(authority, status)
      : kAuthorityVaultsByUpdated(authority);

    try {
      // Fetch limit + 1 to determine if there are more results
      pdas = await zrevrangebyscore(
        zsetKey,
        maxScore,
        0,
        { offset: 0, count: limit + 1 }
      );
      usedZset = true;
    } catch (err) {
      // Fallback to SET if ZSET doesn't exist yet (with client-side filtering)
      pdas = await smembers(kAuthorityVaults(authority));

      // Hard limit to prevent memory issues with large SETs
      if (pdas.length > MAX_SET_SIZE) {
        errorLog(`SET too large for authority ${authority}`, { vaultCount: pdas.length, maxAllowed: MAX_SET_SIZE });
        return error(res, 503, "Too many vaults - ZSET index not ready. Please retry in a few seconds.");
      }

      // Log warning for large SET fallbacks
      if (pdas.length > SET_WARNING_THRESHOLD) {
        errorLog(`Large SET fallback for authority ${authority}`, { vaultCount: pdas.length, severity: "warning" });
      }
    }

    // Fetch all vaults in parallel
    const pipeline = pdas.map(async (pda) => {
      const key = kVaultJson(pda);
      return getJSON<VaultDTO>(key);
    });

    const results = await Promise.all(pipeline);
    const vaults: VaultDTO[] = [];
    results.forEach((v, i) => {
      if (v === null) {
        errorLog("Vault JSON missing for indexed PDA", { pda: pdas[i], authority });
      } else {
        vaults.push(v);
      }
    });

    // Only filter by status if using SET fallback (ZSET already filtered by status)
    const filtered = (usedZset || !status)
      ? vaults
      : vaults.filter((v) => v.status === status);

    // Sort by updatedAtEpoch DESC only if using unordered SET fallback
    // ZSET already provides sorted order (most recent first)
    if (!usedZset) {
      filtered.sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch);
    }

    // Check if there are more results
    const hasMore = filtered.length > limit;
    const items = filtered.slice(0, limit);
    const nextCursor = hasMore && items.length > 0
      ? items[items.length - 1].updatedAtEpoch
      : null;

    const body = {
      items,
      nextCursor,
      total: hasMore ? null : filtered.length, // Don't compute total if paginated
    };

    const etag = createEtag(body);

    // Handle 304 Not Modified
    if (req.headers["if-none-match"] === etag) {
      res.setHeader("ETag", etag);
      res.setHeader(
        "Cache-Control",
        `s-maxage=${cfg.cacheTtl}, stale-while-revalidate=${cfg.cacheTtl * 2}`
      );
      const duration = Date.now() - start;
      logRequest("GET", "/api/vaults", 304, duration);
      recordRequest("/api/vaults", 304, duration);
      return res.status(304).end();
    }

    const duration = Date.now() - start;
    logRequest("GET", "/api/vaults", 200, duration);
    recordRequest("/api/vaults", 200, duration);
    return json(res, 200, body, etag, cfg.cacheTtl);
  } catch (err) {
    const queryError = err instanceof Error ? err : new Error(String(err));
    errorLog("Vaults query failed", { query: req.query, error: queryError });
    const duration = Date.now() - start;
    logRequest("GET", "/api/vaults", 500, duration);
    recordRequest("/api/vaults", 500, duration);
    return error(res, 500, "Internal server error");
  }
}
