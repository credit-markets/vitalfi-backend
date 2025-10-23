/**
 * Health Check Endpoint
 *
 * GET /api/health
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "../lib/kv.js";
import { json, handleCors } from "../lib/http.js";
import { logRequest } from "../lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  try {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return handleCors(res);
    }

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Test KV connectivity
    const client = await kv.getClient();
    const testKey = "health:ts";
    await client.set(testKey, Date.now().toString(), { EX: 5 });
    await client.del(testKey);

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
