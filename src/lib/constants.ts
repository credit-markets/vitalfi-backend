/**
 * Application Constants
 *
 * Centralized configuration values and magic numbers.
 */

/**
 * Redis connection health check interval
 * Only ping if this duration has elapsed since last successful operation
 */
export const PING_INTERVAL_MS = 30000; // 30 seconds

/**
 * Maximum number of vaults to load from SET fallback
 * Prevents memory issues when ZSET indexes aren't ready
 */
export const MAX_SET_SIZE = 1000;

/**
 * Warning threshold for SET fallback usage
 * Logs warning when SET contains more than this many items
 */
export const SET_WARNING_THRESHOLD = 100;

/**
 * Maximum webhook payload size in bytes
 * Prevents DoS attacks via large payloads
 */
export const MAX_WEBHOOK_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB
