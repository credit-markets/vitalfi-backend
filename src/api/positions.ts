/**
 * Positions API
 *
 * GET /api/positions?owner={pubkey}&limit={N}
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { smembers, getJSON, zrevrangebyscore } from "../lib/kv.js";
import { json, error, handleCors } from "../lib/http.js";
import { kOwnerPositions, kOwnerPositionsByUpdated, kPositionJson } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { cfg } from "../lib/env.js";
import { logRequest, errorLog } from "../lib/logger.js";
import { isValidPubkey, cursorSchema } from "../lib/validation.js";
import { MAX_SET_SIZE, SET_WARNING_THRESHOLD } from "../lib/constants.js";
import type { PositionDTO } from "../types/dto.js";

const QuerySchema = z.object({
  owner: z.string().min(32).max(44).refine(isValidPubkey, "Invalid Base58 public key"),
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
    let usedZset = false;

    try {
      // Fetch limit + 1 to determine if there are more results
      pdas = await zrevrangebyscore(
        kOwnerPositionsByUpdated(owner),
        maxScore,
        0,
        { offset: 0, count: limit + 1 }
      );
      usedZset = true;
    } catch (err) {
      // Fallback to SET if ZSET doesn't exist yet
      pdas = await smembers(kOwnerPositions(owner));

      // Hard limit to prevent memory issues with large SETs
      if (pdas.length > MAX_SET_SIZE) {
        errorLog(`SET too large for owner ${owner}`, { positionCount: pdas.length, maxAllowed: MAX_SET_SIZE });
        return error(res, 503, "Too many positions - ZSET index not ready. Please retry in a few seconds.");
      }

      // Log warning for large SET fallbacks
      if (pdas.length > SET_WARNING_THRESHOLD) {
        errorLog(`Large SET fallback for owner ${owner}`, { positionCount: pdas.length, severity: "warning" });
      }
    }

    // Fetch all positions in parallel
    const pipeline = pdas.map(async (pda) => {
      const key = kPositionJson(pda);
      return getJSON<PositionDTO>(key);
    });

    const results = await Promise.all(pipeline);
    const positions: PositionDTO[] = [];
    results.forEach((p, i) => {
      if (p === null) {
        errorLog("Position JSON missing for indexed PDA", { pda: pdas[i], owner });
      } else {
        positions.push(p);
      }
    });

    // Sort by updatedAtEpoch DESC only if using unordered SET fallback
    // ZSET already provides sorted order (most recent first)
    if (!usedZset) {
      positions.sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch);
    }

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
    const queryError = err instanceof Error ? err : new Error(String(err));
    errorLog("Positions query failed", { query: req.query, error: queryError });
    logRequest("GET", "/api/positions", 500, Date.now() - start);
    return error(res, 500, "Internal server error");
  }
}
