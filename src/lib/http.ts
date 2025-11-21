/**
 * HTTP Response Helpers
 *
 * Utilities for sending JSON responses with proper caching headers and ETags.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cfg } from "./env.js";

/**
 * Get CORS origin header value based on request origin
 * Supports multiple origins by checking if request origin is in allowed list
 */
function getCorsOrigin(requestOrigin?: string): string {
  const allowedOrigins = cfg.corsOrigins.split(",").map(o => o.trim());

  // If request origin is in allowed list, echo it back
  // This is required for credentials and allows multiple origins
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  // If wildcard is allowed, use it
  if (allowedOrigins.includes("*")) {
    return "*";
  }

  // Default to first allowed origin
  return allowedOrigins[0];
}


/**
 * Send JSON response with optional ETag and cache headers
 */
export function json<T = Record<string, any>>(
  res: VercelResponse,
  status: number,
  body: T,
  req: VercelRequest,
  etag?: string,
  cacheSeconds?: number
): VercelResponse {
  res.status(status);
  res.setHeader("Content-Type", "application/json");

  // CORS headers - restrict to allowed origins
  const origin = req.headers?.origin as string | undefined;
  res.setHeader("Access-Control-Allow-Origin", getCorsOrigin(origin));
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
  req: VercelRequest,
  details?: Record<string, any> | string | any[]
): VercelResponse {
  const body: { error: string; details?: typeof details } = { error: message };
  if (details !== undefined) {
    body.details = details;
  }
  return json(res, status, body, req);
}

/**
 * Handle CORS preflight OPTIONS requests
 */
export function handleCors(res: VercelResponse, req: VercelRequest): VercelResponse {
  const origin = req.headers?.origin as string | undefined;
  res.setHeader("Access-Control-Allow-Origin", getCorsOrigin(origin));
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match, X-Api-Key");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
  return res.status(200).end();
}

/**
 * Check If-None-Match header and return 304 if ETag matches
 * Returns true if 304 was sent, false otherwise
 */
export function handleNotModified(
  req: { headers: Record<string, string | string[] | undefined> },
  res: VercelResponse,
  etag: string
): boolean {
  if (req.headers["if-none-match"] === etag) {
    res.setHeader("ETag", etag);
    res.setHeader(
      "Cache-Control",
      `s-maxage=${cfg.cacheTtl}, stale-while-revalidate=${cfg.cacheTtl * 2}`
    );
    res.status(304).end();
    return true;
  }
  return false;
}
