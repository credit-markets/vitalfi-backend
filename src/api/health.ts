/**
 * Health Check Endpoint
 *
 * GET /api/health
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "../lib/kv.js";
import { json, error, handleCors } from "../lib/http.js";
import { logRequest, errorLog } from "../lib/logger.js";
import { cfg } from "../lib/env.js";

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

    const health = {
      ok: true,
      services: {
        kv: false,
        solana: false,
      },
      details: {} as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    };

    // Test KV connectivity with read-only PING
    try {
      const client = await kv.getClient();
      await client.ping();
      health.services.kv = true;
    } catch (err) {
      errorLog("Health check: KV failed", err);
      health.details.kvError = err instanceof Error ? err.message : "Unknown error";
    }

    // Test Solana RPC connectivity
    try {
      const rpcResponse = await fetch(cfg.solanaRpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSlot",
          params: [{ commitment: "confirmed" }]
        })
      });
      const rpcResult = await rpcResponse.json();
      if (rpcResult.result) {
        health.services.solana = true;
        health.details.slot = rpcResult.result;
      } else {
        health.details.solanaError = rpcResult.error?.message || "No slot returned";
      }
    } catch (err) {
      errorLog("Health check: Solana RPC failed", err);
      health.details.solanaError = err instanceof Error ? err.message : "Unknown error";
    }

    // Overall health is OK only if all services are healthy
    health.ok = Object.values(health.services).every(s => s);

    const duration = Date.now() - start;
    const status = health.ok ? 200 : 503;
    logRequest("GET", "/api/health", status, duration);

    return json(res, status, health);
  } catch (err) {
    const duration = Date.now() - start;
    errorLog("Health check failed", err);
    logRequest("GET", "/api/health", 500, duration);

    return json(res, 500, {
      ok: false,
      services: { kv: false, solana: false },
    });
  }
}
