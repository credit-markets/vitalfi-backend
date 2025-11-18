/**
 * HTTP Response Helpers
 *
 * Utilities for sending JSON responses with proper caching headers and ETags.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cfg } from "./env.js";

/**
 * Get CORS origin based on request origin and allowed list
 */
function getCorsOrigin(requestOrigin: string | undefined): string {
  if (!requestOrigin) return cfg.corsOrigins.split(",")[0];

  const allowedOrigins = cfg.corsOrigins.split(",").map(o => o.trim());

  // Check if request origin is in allowed list
  if (allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Default to first allowed origin
  return allowedOrigins[0];
}

/**
 * Send JSON response with optional ETag and cache headers
 */
export function json(
  res: VercelResponse,
  status: number,
  body: unknown,
  etag?: string,
  cacheSeconds?: number,
  requestOrigin?: string
): VercelResponse {
  res.status(status);
  res.setHeader("Content-Type", "application/json");

  // CORS headers - restrict to allowed origins
  res.setHeader("Access-Control-Allow-Origin", getCorsOrigin(requestOrigin));
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match, X-Api-Key");

  if (etag) {
    res.setHeader("ETag", etag);
  }

  if (cacheSeconds) {
    res.setHeader(
      "Cache-Control",
      `s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`
    );
  }

  return res.json(body);
}

/**
 * Send error response
 */
export function error(
  res: VercelResponse,
  status: number,
  message: string,
  details?: unknown
): VercelResponse {
  const body: { error: string; details?: unknown } = { error: message };
  if (details) {
    body.details = details;
  }
  return json(res, status, body);
}

/**
 * Handle CORS preflight OPTIONS requests
 */
export function handleCors(res: VercelResponse, requestOrigin?: string): VercelResponse {
  res.setHeader("Access-Control-Allow-Origin", getCorsOrigin(requestOrigin));
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match, X-Api-Key");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
  return res.status(200).end();
}
