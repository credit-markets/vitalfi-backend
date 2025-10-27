/**
 * HTTP Response Helpers
 *
 * Utilities for sending JSON responses with proper caching headers and ETags.
 */

import type { VercelResponse } from "@vercel/node";

/**
 * Send JSON response with optional ETag and cache headers
 */
export function json(
  res: VercelResponse,
  status: number,
  body: unknown,
  etag?: string,
  cacheSeconds?: number
): VercelResponse {
  res.status(status);
  res.setHeader("Content-Type", "application/json");

  // CORS headers - allow all origins for public API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match");

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
export function handleCors(res: VercelResponse): VercelResponse {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
  return res.status(200).end();
}
