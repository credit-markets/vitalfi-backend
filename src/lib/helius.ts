/**
 * Helius Webhook Helpers
 *
 * HMAC verification, log parsing, and account decoding.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { getCoder, type DecodedVault, type DecodedPosition } from "./anchor.js";
import type { HeliusWebhookPayload, HeliusAccountData } from "../types/helius.js";
import { cfg } from "./env.js";

/**
 * Verify Helius webhook signature using HMAC
 */
export function verifyHeliusSignature(signature: string, rawBody: string): boolean {
  if (!signature) {
    return false;
  }

  const computed = createHmac("sha256", cfg.heliusSecret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signature);
    const computedBuffer = Buffer.from(computed);
    if (sigBuffer.length !== computedBuffer.length) {
      return false;
    }
    return timingSafeEqual(sigBuffer, computedBuffer);
  } catch {
    return false;
  }
}

/**
 * Extract instruction names from Anchor logs
 */
export function extractActionsFromLogs(payload: HeliusWebhookPayload): string[] {
  const logs = payload.meta?.logMessages || [];
  const actions: string[] = [];

  const patterns: Record<string, RegExp> = {
    deposit: /Instruction:\s*Deposit/i,
    claim: /Instruction:\s*Claim/i,
    finalizeFunding: /Instruction:\s*FinalizeFunding/i,
    matureVault: /Instruction:\s*MatureVault/i,
    initializeVault: /Instruction:\s*InitializeVault/i,
    closeVault: /Instruction:\s*CloseVault/i,
  };

  for (const log of logs) {
    for (const [action, pattern] of Object.entries(patterns)) {
      if (pattern.test(log)) {
        actions.push(action);
      }
    }
  }

  return actions;
}

/**
 * Decode account data from Helius webhook
 */
export function decodeAccounts(
  coder: ReturnType<typeof getCoder>,
  accountData: HeliusAccountData[]
): Array<{
  type: "vault" | "position";
  pda: string;
  data: DecodedVault | DecodedPosition;
}> {
  const results: Array<{
    type: "vault" | "position";
    pda: string;
    data: DecodedVault | DecodedPosition;
  }> = [];

  for (const item of accountData) {
    // Only process accounts owned by VitalFi program
    if (item.owner !== cfg.programId) {
      continue;
    }

    const buffer = Buffer.from(item.data, "base64");

    // Try decoding as Vault
    try {
      const decoded = coder.accounts.decode("vault", buffer);
      results.push({
        type: "vault",
        pda: item.account,
        data: decoded as DecodedVault,
      });
      continue;
    } catch {
      // Not a vault, try position
    }

    // Try decoding as Position
    try {
      const decoded = coder.accounts.decode("position", buffer);
      results.push({
        type: "position",
        pda: item.account,
        data: decoded as DecodedPosition,
      });
    } catch {
      // Not a position either, skip
    }
  }

  return results;
}
