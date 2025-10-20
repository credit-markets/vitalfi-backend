/**
 * Health Check Endpoint
 *
 * GET /api/health
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "../lib/kv.js";
import { json } from "../lib/http.js";
import { logRequest } from "../lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Test KV connectivity
    const testKey = "health:ts";
    await kv.set(testKey, Date.now(), { ex: 5 });
    await kv.del(testKey);

    const duration = Date.now() - start;
    logRequest("GET", "/api/health", 200, duration);

    return json(res, 200, {
      ok: true,
      kv: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const duration = Date.now() - start;
    logRequest("GET", "/api/health", 500, duration);

    return json(res, 500, {
      ok: false,
      kv: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
