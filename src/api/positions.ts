/**
 * Positions API
 *
 * GET /api/positions?owner={pubkey}&limit={N}
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { kv } from "../lib/kv.js";
import { smembers } from "../lib/kv.js";
import { json, error } from "../lib/http.js";
import { kOwnerPositions, kPositionJson } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { cfg } from "../lib/env.js";
import { logRequest } from "../lib/logger.js";
import type { PositionDTO } from "../types/dto.js";

const QuerySchema = z.object({
  owner: z.string().min(32).max(44),
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

    const { owner, limit } = parsed.data;

    // Get position PDAs for owner
    const pdas = await smembers(kOwnerPositions(owner));

    // Fetch all positions in parallel
    const pipeline = pdas.map(async (pda) => {
      const key = kPositionJson(pda);
      return kv.get<PositionDTO>(`${cfg.prefix}${key}`);
    });

    const positions = (await Promise.all(pipeline)).filter(
      (p): p is PositionDTO => p !== null
    );

    // Sort by slot DESC (most recent first)
    positions.sort((a, b) => (b.slot || 0) - (a.slot || 0));

    // Paginate
    const items = positions.slice(0, limit);

    const body = {
      items,
      nextCursor: null,
      total: positions.length,
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
