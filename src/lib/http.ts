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
