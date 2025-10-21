/**
 * Positions API
 *
 * GET /api/positions?owner={pubkey}&limit={N}
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { smembers, getJSON, zrevrangebyscore } from "../lib/kv.js";
import { json, error } from "../lib/http.js";
import { kOwnerPositions, kOwnerPositionsByUpdated, kPositionJson } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { cfg } from "../lib/env.js";
import { logRequest, errorLog } from "../lib/logger.js";
import { isValidPubkey } from "../lib/validation.js";
import type { PositionDTO } from "../types/dto.js";

const QuerySchema = z.object({
  owner: z.string().min(32).max(44).refine(isValidPubkey, "Invalid Base58 public key"),
  cursor: z.coerce.number().int().positive().optional(),
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

    const { owner, cursor, limit } = parsed.data;

    // Use exclusive cursor to prevent duplicate items across pages
    // Redis ZREVRANGEBYSCORE supports exclusive ranges with parentheses
    const maxScore = cursor !== undefined ? `(${cursor}` : '+inf';
    let pdas: string[];

    try {
      // Fetch limit + 1 to determine if there are more results
      pdas = await zrevrangebyscore(
        kOwnerPositionsByUpdated(owner),
        maxScore,
        0,
        { offset: 0, count: limit + 1 }
      );
    } catch (err) {
      // Fallback to SET if ZSET doesn't exist yet
      pdas = await smembers(kOwnerPositions(owner));

      // Hard limit to prevent memory issues with large SETs
      const MAX_SET_SIZE = 1000;
      if (pdas.length > MAX_SET_SIZE) {
        errorLog(`SET too large for owner ${owner}`, { positionCount: pdas.length, maxAllowed: MAX_SET_SIZE });
        return error(res, 503, "Too many positions - ZSET index not ready. Please retry in a few seconds.");
      }

      // Log warning for large SET fallbacks
      if (pdas.length > 100) {
        errorLog(`Large SET fallback for owner ${owner}`, { positionCount: pdas.length, severity: "warning" });
      }
    }

    // Fetch all positions in parallel
    const pipeline = pdas.map(async (pda) => {
      const key = kPositionJson(pda);
      return getJSON<PositionDTO>(key);
    });

    const positions = (await Promise.all(pipeline)).filter(
      (p): p is PositionDTO => p !== null
    );

    // Sort by updatedAtEpoch DESC (most recent first)
    positions.sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch);

    // Check if there are more results
    const hasMore = positions.length > limit;
    const items = positions.slice(0, limit);
    const nextCursor = hasMore && items.length > 0
      ? items[items.length - 1].updatedAtEpoch
      : null;

    const body = {
      items,
      nextCursor,
      total: hasMore ? null : positions.length, // Don't compute total if paginated
    };

    const etag = createEtag(body);

    // Handle 304 Not Modified
    if (req.headers["if-none-match"] === etag) {
      res.setHeader("ETag", etag);
      res.setHeader(
        "Cache-Control",
        `s-maxage=${cfg.cacheTtl}, stale-while-revalidate=${cfg.cacheTtl * 2}`
      );
      logRequest("GET", "/api/positions", 304, Date.now() - start);
      return res.status(304).end();
    }

    logRequest("GET", "/api/positions", 200, Date.now() - start);
    return json(res, 200, body, etag, cfg.cacheTtl);
  } catch (err) {
    logRequest("GET", "/api/positions", 500, Date.now() - start);
    return error(res, 500, "Internal server error");
  }
}
