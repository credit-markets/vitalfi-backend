/**
 * Metrics API
 *
 * GET /api/metrics
 *
 * Returns application metrics for monitoring dashboards.
 * Protected with API key authentication.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "crypto";
import { json, error, handleCors } from "../lib/http.js";
import { getMetrics } from "../lib/metrics.js";
import { logRequest } from "../lib/logger.js";
import { cfg } from "../lib/env.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCors(res, req);
  }

  if (req.method !== "GET") {
    return error(res, 405, "Method not allowed", req);
  }

  // Protect with API key if configured
  if (cfg.metricsApiKey) {
    const apiKey = req.headers["x-api-key"];
    try {
      const apiKeyBuffer = Buffer.from(typeof apiKey === 'string' ? apiKey : '');
      const secretBuffer = Buffer.from(cfg.metricsApiKey);
      if (apiKeyBuffer.length !== secretBuffer.length || !timingSafeEqual(apiKeyBuffer, secretBuffer)) {
        logRequest("GET", "/api/metrics", 401, Date.now() - start);
        return error(res, 401, "Unauthorized", req);
      }
    } catch {
      logRequest("GET", "/api/metrics", 401, Date.now() - start);
      return error(res, 401, "Unauthorized", req);
    }
  }

  const metrics = getMetrics();

  // Add alerting thresholds
  const alerts = {
    highErrorRate: metrics.totals.errorRate > 1, // > 1% error rate
    highWebhookErrorRate: metrics.webhook.errorRate > 5, // > 5% webhook errors
    highLatency: Object.values(metrics.requests).some(
      (r) => r.latency.p99 > 1000 // p99 > 1 second
    ),
  };

  const response = {
    ...metrics,
    alerts,
    timestamp: new Date().toISOString(),
  };

  logRequest("GET", "/api/metrics", 200, Date.now() - start);
  return json(res, 200, response, req);
}
