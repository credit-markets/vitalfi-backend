/**
 * Validation Helpers
 *
 * Input validation utilities for API endpoints.
 */

import { z } from "zod";
import { getMaxCursorValue } from "./constants.js";

/**
 * Base58 character set used by Solana public keys
 */
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validate if a string is a valid Solana public key (Base58 encoded)
 */
export function isValidPubkey(pubkey: string): boolean {
  // Solana pubkeys are 32 bytes encoded in Base58, typically 32-44 characters
  if (pubkey.length < 32 || pubkey.length > 44) {
    return false;
  }

  // Check if it only contains Base58 characters
  return BASE58_REGEX.test(pubkey);
}

/**
 * Shared cursor validation schema
 * Validates Unix epoch seconds with optional future allowance for clock skew/test data
 * Uses .refine() for dynamic validation to prevent stale max values in long-lived serverless instances
 */
export const cursorSchema = z.coerce
  .number()
  .int()
  .positive()
  .refine(
    (val) => val <= getMaxCursorValue(),
    { message: "Cursor value too far in the future" }
  )
  .optional();
