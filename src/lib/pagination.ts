/**
 * Pagination Helpers
 *
 * Utilities for cursor-based pagination using ZSET scores (blockTime).
 */

/**
 * Parse cursor from query string
 * Cursor is an ISO timestamp or null
 */
export function parseCursor(cursorStr: string | null | undefined): number {
  if (!cursorStr) {
    return Number.POSITIVE_INFINITY; // +inf for first page
  }

  const date = new Date(cursorStr);
  if (isNaN(date.getTime())) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor(date.getTime() / 1000); // Unix epoch seconds
}

/**
 * Generate next cursor from last item
 */
export function nextCursorFromLastItem(
  lastItem: { blockTime: string | null } | null
): string | null {
  if (!lastItem || !lastItem.blockTime) {
    return null;
  }
  return lastItem.blockTime;
}
