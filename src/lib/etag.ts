/**
 * ETag Generation
 *
 * Creates weak ETags from JSON bodies for HTTP caching.
 */

import { createHash } from "crypto";

/**
 * Generate weak ETag from object
 */
export function createEtag(body: unknown): string {
  const json = JSON.stringify(body);
  const hash = createHash("sha1").update(json).digest("hex");
  return `W/"${hash.substring(0, 16)}"`;
}
