/**
 * Activity API
 *
 * GET /api/activity?vault={pda}&cursor={iso}&limit={N}
 * GET /api/activity?owner={pubkey}&cursor={iso}&limit={N}
 */

import type { VercelRequest, VercelResponse} from "@vercel/node";
import { z } from "zod";
import { kv } from "../lib/kv.js";
import { zrevrangebyscore } from "../lib/kv.js";
import { json, error } from "../lib/http.js";
import { kVaultActivity, kOwnerActivity, kActivity } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { parseCursor, nextCursorFromLastItem } from "../lib/pagination.js";
import { cfg } from "../lib/env.js";
import { logRequest } from "../lib/logger.js";
import type { ActivityDTO } from "../types/dto.js";

const QuerySchema = z.object({
  vault: z.string().min(32).max(44).optional(),
  owner: z.string().min(32).max(44).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
}).refine((data) => data.vault || data.owner, {
  message: "Either vault or owner must be provided",
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

    const { vault, owner, cursor, limit } = parsed.data;

    // Choose ZSET key
    const zsetKey = vault ? kVaultActivity(vault) : kOwnerActivity(owner!);

    // Parse cursor (ISO timestamp → Unix epoch)
    const maxScore = parseCursor(cursor);

    // Fetch activity IDs from ZSET (reverse chronological order)
    // Fetch limit+1 to detect if there are more items
    const activityIds = await zrevrangebyscore(zsetKey, maxScore, "-inf", {
      offset: 0,
      count: limit + 1,
    });

    // Determine if there are more items
    const hasMore = activityIds.length > limit;
    const idsToFetch = hasMore ? activityIds.slice(0, limit) : activityIds;

    // Fetch activity JSONs in parallel
    const pipeline = idsToFetch.map(async (id) => {
      return kv.get<ActivityDTO>(`${cfg.prefix}${id}`);
    });

    const activities = (await Promise.all(pipeline)).filter(
      (a): a is ActivityDTO => a !== null
    );

    // Compute next cursor
    const nextCursor = hasMore ? nextCursorFromLastItem(activities[activities.length - 1]) : null;

    const body = {
      items: activities,
      nextCursor,
      total: null, // Total count not available in ZSET without full scan
    };

    const etag = createEtag(body);

    // Handle 304 Not Modified
    if (req.headers["if-none-match"] === etag) {
      res.setHeader("ETag", etag);
      res.setHeader(
        "Cache-Control",
        `s-maxage=${cfg.cacheTtl}, stale-while-revalidate=${cfg.cacheTtl * 2}`
      );
      logRequest("GET", "/api/activity", 304, Date.now() - start);
      return res.status(304).end();
    }

    logRequest("GET", "/api/activity", 200, Date.now() - start);
    return json(res, 200, body, etag, cfg.cacheTtl);
  } catch (err) {
    logRequest("GET", "/api/activity", 500, Date.now() - start);
    return error(res, 500, "Internal server error");
  }
}
