/**
 * Vaults API
 *
 * GET /api/vaults?authority={pubkey}&status={status}&limit={N}
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { smembers, getJSON, zrevrangebyscore } from "../lib/kv.js";
import { json, error } from "../lib/http.js";
import { kAuthorityVaults, kAuthorityVaultsByUpdated, kVaultJson } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { cfg } from "../lib/env.js";
import { logRequest, errorLog } from "../lib/logger.js";
import { isValidPubkey } from "../lib/validation.js";
import type { VaultDTO } from "../types/dto.js";

const QuerySchema = z.object({
  authority: z.string().min(32).max(44).refine(isValidPubkey, "Invalid Base58 public key"),
  status: z.enum(["Funding", "Active", "Matured", "Canceled"]).optional(),
  cursor: z.coerce.number().int().positive().max(Math.floor(Date.now() / 1000) + 86400).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  try {
    if (req.method !== "GET") {
      return error(res, 405, "Method not allowed");
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
      const MAX_SET_SIZE = 1000;
      if (pdas.length > MAX_SET_SIZE) {
        errorLog(`SET too large for authority ${authority}`, { vaultCount: pdas.length, maxAllowed: MAX_SET_SIZE });
        return error(res, 503, "Too many vaults - ZSET index not ready. Please retry in a few seconds.");
      }

      // Log warning for large SET fallbacks
      if (pdas.length > 100) {
        errorLog(`Large SET fallback for authority ${authority}`, { vaultCount: pdas.length, severity: "warning" });
      }
    }

    // Fetch all vaults in parallel
    const pipeline = pdas.map(async (pda) => {
      const key = kVaultJson(pda);
      return getJSON<VaultDTO>(key);
    });

    const vaults = (await Promise.all(pipeline)).filter(
      (v): v is VaultDTO => v !== null
    );

    // Only filter by status if using SET fallback (ZSET already filtered by status)
    const filtered = (usedZset || !status)
      ? vaults
      : vaults.filter((v) => v.status === status);

    // Sort by updatedAtEpoch DESC (most recent first)
    filtered.sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch);

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
      logRequest("GET", "/api/vaults", 304, Date.now() - start);
      return res.status(304).end();
    }

    logRequest("GET", "/api/vaults", 200, Date.now() - start);
    return json(res, 200, body, etag, cfg.cacheTtl);
  } catch (err) {
    errorLog("Vaults query failed", { query: req.query, err });
    logRequest("GET", "/api/vaults", 500, Date.now() - start);
    return error(res, 500, "Internal server error");
  }
}
