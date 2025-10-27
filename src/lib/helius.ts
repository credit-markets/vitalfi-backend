/**
 * Helius Webhook Helpers
 *
 * HMAC verification, log parsing, and account decoding.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getCoder, type DecodedVault, type DecodedPosition } from "./anchor.js";
import type { RawWebhookPayload } from "../types/helius.js";
import type { AccountInfo } from "./solana.js";
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
export function extractActionsFromLogs(payload: RawWebhookPayload): string[] {
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
 * Decode account data fetched from RPC
 */
export function decodeAccounts(
  coder: ReturnType<typeof getCoder>,
  accountInfos: AccountInfo[]
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

  for (const info of accountInfos) {
    const buffer = Buffer.from(info.data, "base64");

    // Try decoding as Vault (capitalized - matches IDL)
    try {
      const decoded = coder.accounts.decode("Vault", buffer);
      results.push({
        type: "vault",
        pda: info.pubkey,
        data: decoded as DecodedVault,
      });
      continue;
    } catch {
      // Try Position next
    }

    // Try decoding as Position (capitalized - matches IDL)
    try {
      const decoded = coder.accounts.decode("Position", buffer);
      results.push({
        type: "position",
        pda: info.pubkey,
        data: decoded as DecodedPosition,
      });
    } catch {
      // Not a vault or position account
    }
  }

  return results;
}
