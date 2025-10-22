/**
 * Helius Webhook Handler
 *
 * POST /api/webhooks/helius?token={secret}
 *
 * Receives account update events from Helius, decodes with Anchor,
 * normalizes to DTOs, and writes to KV with indexes.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "crypto";
import { json, error } from "../../lib/http.js";
import { verifyHeliusSignature, extractActionsFromLogs, decodeAccounts } from "../../lib/helius.js";
import { getCoder } from "../../lib/anchor.js";
import { toVaultDTO, toPositionDTO, toActivityDTO } from "../../lib/normalize.js";
import { setJSON, sadd, zadd, zrem, setnx, batchOperations, getJSON } from "../../lib/kv.js";
import {
  kVaultJson,
  kVaultsSet,
  kAuthorityVaults,
  kAuthorityVaultsByUpdated,
  kPositionJson,
  kOwnerPositions,
  kOwnerPositionsByUpdated,
  kVaultActivity,
  kOwnerActivity,
  kActivity,
} from "../../lib/keys.js";
import { cfg } from "../../lib/env.js";
import { info, errorLog } from "../../lib/logger.js";
import { MAX_WEBHOOK_PAYLOAD_SIZE } from "../../lib/constants.js";
import type { HeliusWebhookPayload } from "../../types/helius.js";
import { heliusWebhookPayloadSchema } from "../../types/helius.js";

// Configure to read raw body for HMAC verification
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Read raw body from request stream with size limit
 */
async function getRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;

      // Prevent DoS via large payloads
      if (size > MAX_WEBHOOK_PAYLOAD_SIZE) {
        reject(new Error("Payload too large"));
        return;
      }

      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return error(res, 405, "Method not allowed");
    }

    // Read raw body for HMAC verification with size validation
    let rawBody: string;
    try {
      rawBody = await getRawBody(req);
    } catch (err) {
      const error_msg = err instanceof Error ? err.message : String(err);
      if (error_msg.includes("Payload too large")) {
        errorLog("Webhook payload too large", { error: error_msg });
        return error(res, 413, "Payload too large");
      }
      throw err;
    }

    // Verify token from multiple sources for Helius webhook compatibility:
    // - Query param: ?token={secret} (legacy/URL-based auth)
    // - Authorization header: Used by some webhook services
    // - Authentication header: Helius Enhanced webhooks use this
    const token = (req.query.token as string | undefined) ||
                  (req.headers.authorization as string | undefined) ||
                  (req.headers["authentication"] as string | undefined);

    // Use timing-safe comparison to prevent timing attacks
    if (!token || token.length !== cfg.heliusSecret.length) {
      errorLog("Invalid or missing authentication token in webhook request");
      return error(res, 401, "Invalid token");
    }

    const tokenMatch = timingSafeEqual(
      Buffer.from(token),
      Buffer.from(cfg.heliusSecret)
    );

    if (!tokenMatch) {
      errorLog("Invalid authentication token in webhook request");
      return error(res, 401, "Invalid token");
    }

    // Verify HMAC signature (optional - Helius may not send this for all webhook types)
    const signature = req.headers["x-helius-signature"] as string | undefined;
    if (signature) {
      // If signature is provided, verify it
      if (!verifyHeliusSignature(signature, rawBody)) {
        errorLog("Invalid HMAC signature in webhook request");
        return error(res, 401, "Invalid signature");
      }
      info("HMAC signature verified successfully");
    } else {
      info("No HMAC signature provided - relying on authentication token only");
    }

    // Parse and validate JSON payload
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawBody);
    } catch (err) {
      const parseError = err instanceof Error ? err : new Error(String(err));
      errorLog("Failed to parse webhook payload", parseError);
      return error(res, 400, "Invalid JSON payload");
    }

    // Validate payload structure with Zod
    const validationResult = heliusWebhookPayloadSchema.safeParse(rawPayload);

    if (!validationResult.success) {
      // Log the actual payload structure for debugging (sanitize keys to prevent log injection)
      const sanitizeKey = (k: string) => k.slice(0, 100).replace(/[\r\n\x00-\x1F]/g, '?');
      info("Received webhook with invalid structure - likely a test payload", {
        payloadKeys: typeof rawPayload === 'object' && rawPayload !== null
          ? Object.keys(rawPayload).slice(0, 10).map(sanitizeKey)
          : [],
        validationErrors: validationResult.error.errors,
      });

      // Return success for test payloads (they don't have valid structure)
      return json(res, 200, {
        ok: true,
        message: "Test webhook received (invalid structure - no data to process)",
        processed: {
          vaults: 0,
          positions: 0,
          activities: 0,
        },
      });
    }

    const payload: HeliusWebhookPayload = validationResult.data;

    info("Received Helius webhook", {
      signature: payload.signature,
      slot: payload.slot,
      accountCount: payload.accountData.length,
    });

    // Get Anchor coder
    const coder = getCoder();

    // Decode accounts (skip if empty - e.g. test payloads)
    const decoded = payload.accountData.length > 0
      ? decodeAccounts(coder, payload.accountData)
      : [];

    let vaultsProcessed = 0;
    let positionsProcessed = 0;

    // Store old account states for amount delta calculation
    const oldVaults = new Map<string, import("../../types/dto.js").VaultDTO>();
    const oldPositions = new Map<string, import("../../types/dto.js").PositionDTO>();

    // Batch fetch all existing vaults and positions in parallel (performance optimization)
    const vaultPdas = decoded.filter(d => d.type === "vault").map(d => d.pda);
    const positionPdas = decoded.filter(d => d.type === "position").map(d => d.pda);

    const [existingVaults, existingPositions] = await Promise.all([
      Promise.all(vaultPdas.map(pda => getJSON<import("../../types/dto.js").VaultDTO>(kVaultJson(pda)))),
      Promise.all(positionPdas.map(pda => getJSON<import("../../types/dto.js").PositionDTO>(kPositionJson(pda)))),
    ]);

    // Build maps for quick lookup
    vaultPdas.forEach((pda, i) => {
      const existing = existingVaults[i];
      if (existing) {
        oldVaults.set(pda, existing);
      }
    });

    positionPdas.forEach((pda, i) => {
      const existing = existingPositions[i];
      if (existing) {
        oldPositions.set(pda, existing);
      }
    });

    // Process each decoded account with batch operations for better performance
    const accountOperations: Promise<unknown>[] = [];

    for (const item of decoded) {
      if (item.type === "vault") {
        const vaultData = item.data as import("../../lib/anchor.js").DecodedVault;
        const dto = toVaultDTO(item.pda, vaultData, payload.slot, payload.blockTime);

        // Get existing vault from pre-fetched map
        const existingVault = oldVaults.get(item.pda);

        // Batch all vault operations including ZSET for ordering
        // Also write to per-status ZSET for efficient filtered queries
        const vaultOps: Promise<unknown>[] = [
          setJSON(kVaultJson(item.pda), dto),
          sadd(kVaultsSet(), item.pda),
          sadd(kAuthorityVaults(dto.authority), item.pda),
          zadd(kAuthorityVaultsByUpdated(dto.authority), dto.updatedAtEpoch, item.pda),
          zadd(kAuthorityVaultsByUpdated(dto.authority, dto.status), dto.updatedAtEpoch, item.pda)
        ];

        // If status changed, remove from old per-status ZSET to prevent stale entries
        const statusChanged = existingVault && existingVault.status !== dto.status;
        if (statusChanged) {
          vaultOps.push(
            zrem(kAuthorityVaultsByUpdated(dto.authority, existingVault.status), item.pda)
          );
        }

        accountOperations.push(...vaultOps);
        vaultsProcessed++;
      } else if (item.type === "position") {
        const positionData = item.data as import("../../lib/anchor.js").DecodedPosition;
        const dto = toPositionDTO(item.pda, positionData, payload.slot, payload.blockTime);

        // Get existing position from pre-fetched map (no await needed)
        // Already fetched in parallel above

        // Batch all position operations including ZSET for ordering
        accountOperations.push(
          setJSON(kPositionJson(item.pda), dto),
          sadd(kOwnerPositions(dto.owner), item.pda),
          zadd(kOwnerPositionsByUpdated(dto.owner), dto.updatedAtEpoch, item.pda)
        );

        positionsProcessed++;
      }
    }

    // Execute all account operations in parallel
    await batchOperations(() => accountOperations);

    // Extract actions from logs
    const actions = extractActionsFromLogs(payload);

    let activitiesProcessed = 0;

    // Create activity events
    for (const action of actions) {
      // Try to find associated vault/position from decoded accounts
      const vaultItem = decoded.find((d) => d.type === "vault");
      const positionItem = decoded.find((d) => d.type === "position");

      // Extract amount from account deltas
      let amount: string | undefined;
      let assetMint: string | undefined;

      if (vaultItem?.type === "vault") {
        const newVault = vaultItem.data as import("../../lib/anchor.js").DecodedVault;
        assetMint = newVault.assetMint.toBase58();

        const oldVault = oldVaults.get(vaultItem.pda);

        if (oldVault) {
          // Calculate delta based on action type
          if (action === "deposit" || action === "initializeVault") {
            const oldDeposited = BigInt(oldVault.totalDeposited || "0");
            const newDeposited = newVault.totalDeposited;
            const delta = newDeposited - oldDeposited;
            if (delta > 0n) {
              amount = delta.toString();
            }
          } else if (action === "claim") {
            const oldClaimed = BigInt(oldVault.totalClaimed || "0");
            const newClaimed = newVault.totalClaimed;
            const delta = newClaimed - oldClaimed;
            if (delta > 0n) {
              amount = delta.toString();
            }
          }
        } else {
          // No previous state - use current total for any deposit-like action
          if ((action === "deposit" || action === "initializeVault") && newVault.totalDeposited > 0n) {
            amount = newVault.totalDeposited.toString();
          }
        }
      }

      if (positionItem?.type === "position") {
        const newPosition = positionItem.data as import("../../lib/anchor.js").DecodedPosition;

        const oldPosition = oldPositions.get(positionItem.pda);

        if (oldPosition) {
          // Calculate delta based on action type
          if (action === "deposit") {
            const oldDeposited = BigInt(oldPosition.deposited || "0");
            const newDeposited = newPosition.deposited;
            const delta = newDeposited - oldDeposited;
            if (delta > 0n) {
              amount = delta.toString();
            }
          } else if (action === "claim") {
            const oldClaimed = BigInt(oldPosition.claimed || "0");
            const newClaimed = newPosition.claimed;
            const delta = newClaimed - oldClaimed;
            if (delta > 0n) {
              amount = delta.toString();
            }
          }
        } else {
          // No previous state - use total for first deposit
          if (action === "deposit" && newPosition.deposited > 0n) {
            amount = newPosition.deposited.toString();
          }
        }
      }

      const activityDto = toActivityDTO(action, {
        txSig: payload.signature,
        slot: payload.slot,
        blockTime: payload.blockTime,
        vaultPda: vaultItem?.pda,
        positionPda: positionItem?.pda,
        authority: vaultItem?.type === "vault" ? (vaultItem.data as import("../../lib/anchor.js").DecodedVault).authority.toBase58() : undefined,
        owner: positionItem?.type === "position" ? (positionItem.data as import("../../lib/anchor.js").DecodedPosition).owner.toBase58() : undefined,
        amount,
        assetMint,
      });

      const activityKey = kActivity(payload.signature, activityDto.type, payload.slot);

      // Use SETNX for idempotent writes with configurable TTL to prevent unbounded growth
      const activityTtlSeconds = cfg.activityTtlDays * 24 * 3600;
      const wasNew = await setnx(activityKey, activityDto, { ex: activityTtlSeconds });

      if (wasNew === 1) {
        // Only add to ZSETs if this is a new activity
        // Use blockTimeEpoch for score (fallback to slot if null)
        const score = activityDto.blockTimeEpoch || payload.slot;

        try {
          // Add to ZSETs with proper error handling to maintain consistency
          const zsetOps: Promise<unknown>[] = [];

          if (activityDto.vaultPda) {
            zsetOps.push(zadd(kVaultActivity(activityDto.vaultPda), score, activityKey));
          }

          if (activityDto.owner) {
            zsetOps.push(zadd(kOwnerActivity(activityDto.owner), score, activityKey));
          }

          // Execute all ZSET operations in parallel
          await Promise.all(zsetOps);
          activitiesProcessed++;
        } catch (err) {
          const indexError = err instanceof Error ? err : new Error(String(err));
          errorLog("Failed to index activity in ZSETs", { activityKey, error: indexError });
          // Activity was created but not fully indexed - this will be caught in monitoring
          // Don't re-throw to avoid failing the entire webhook
        }
      }
    }

    info("Webhook processed successfully", {
      vaults: vaultsProcessed,
      positions: positionsProcessed,
      activities: activitiesProcessed,
    });

    return json(res, 200, {
      ok: true,
      processed: {
        vaults: vaultsProcessed,
        positions: positionsProcessed,
        activities: activitiesProcessed,
      },
    });
  } catch (err) {
    const processingError = err instanceof Error ? err : new Error(String(err));
    errorLog("Webhook processing failed", processingError);
    return error(res, 500, "Internal server error");
  }
}
