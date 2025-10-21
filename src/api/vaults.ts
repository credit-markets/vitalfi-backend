/**
 * Vaults API
 *
 * GET /api/vaults?authority={pubkey}&status={status}&limit={N}
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { smembers, getJSON } from "../lib/kv.js";
import { json, error } from "../lib/http.js";
import { kAuthorityVaults, kVaultJson } from "../lib/keys.js";
import { createEtag } from "../lib/etag.js";
import { cfg } from "../lib/env.js";
import { logRequest } from "../lib/logger.js";
import type { VaultDTO } from "../types/dto.js";

const QuerySchema = z.object({
  authority: z.string().min(32).max(44),
  status: z.enum(["Funding", "Active", "Matured", "Canceled"]).optional(),
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

    const { authority, status, limit } = parsed.data;

    // Get vault PDAs for authority
    const pdas = await smembers(kAuthorityVaults(authority));

    // Fetch all vaults in parallel
    const pipeline = pdas.map(async (pda) => {
      const key = kVaultJson(pda);
      return getJSON<VaultDTO>(key);
    });

    const vaults = (await Promise.all(pipeline)).filter(
      (v): v is VaultDTO => v !== null
    );

    // Filter by status if provided
    const filtered = status
      ? vaults.filter((v) => v.status === status)
      : vaults;

    // Sort by slot DESC (most recent first)
    filtered.sort((a, b) => (b.slot || 0) - (a.slot || 0));

    // Paginate
    const items = filtered.slice(0, limit);

    const body = {
      items,
      nextCursor: null,
      total: filtered.length,
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
    logRequest("GET", "/api/vaults", 500, Date.now() - start);
    return error(res, 500, "Internal server error");
  }
}
