/**
 * Minimal Logger
 *
 * Logs with secret redaction for security.
 */

import { cfg } from "./env.js";

const SECRETS_TO_REDACT = [
  cfg.heliusSecret,
  cfg.heliusApiKey,
  cfg.kvToken,
];

/**
 * Redact secrets from string
 */
function redact(str: string): string {
  let redacted = str;
  for (const secret of SECRETS_TO_REDACT) {
    if (secret && secret.length > 4) {
      redacted = redacted.replaceAll(secret, "***REDACTED***");
    }
  }
  return redacted;
}

/**
 * Log info message
 */
export function info(message: string, meta?: Record<string, unknown>): void {
  const log = {
    level: "info",
    message: redact(message),
    meta: meta ? JSON.parse(redact(JSON.stringify(meta))) : undefined,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(log));
}

/**
 * Log error message
 */
export function errorLog(message: string, error?: unknown): void {
  const log = {
    level: "error",
    message: redact(message),
    error: error instanceof Error ? {
      name: error.name,
      message: redact(error.message),
      stack: redact(error.stack || ""),
    } : redact(String(error)),
    timestamp: new Date().toISOString(),
  };
  console.error(JSON.stringify(log));
}

/**
 * Log HTTP request
 */
export function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number
): void {
  info(`${method} ${path}`, { status, durationMs });
}
