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
import { PublicKey } from "@solana/web3.js";
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
import type { RawWebhookPayload } from "../../types/helius.js";
import { heliusWebhookPayloadSchema } from "../../types/helius.js";
import { getMultipleAccounts, filterProgramAccounts } from "../../lib/solana.js";

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

    // Verify HMAC signature from Helius webhook
    const signature = req.headers["x-helius-signature"] as string | undefined;
    if (!signature) {
      errorLog("Missing X-Helius-Signature header in webhook request");
      return error(res, 401, "Missing signature");
    }

    if (!verifyHeliusSignature(signature, rawBody)) {
      errorLog("Invalid HMAC signature in webhook request");
      return error(res, 401, "Invalid signature");
    }

    // Parse JSON payload
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      const parseError = err instanceof Error ? err : new Error(String(err));
      errorLog("Failed to parse webhook payload", parseError);
      return error(res, 400, "Invalid JSON payload");
    }

    // Helius sends arrays of transactions (or test pings as [0])
    if (Array.isArray(body) && body.length === 1 && typeof body[0] === "number") {
      info("Helius test ping (numeric array)");
      return json(res, 200, { ok: true, message: "pong" });
    }

    // Normalize to items array
    const items: any[] = Array.isArray(body) ? body : [body];

    info("Received Helius webhook", { itemCount: items.length });

    // Helper to detect raw transaction format
    // Note: signature may be top-level or inside transaction.signatures[0]
    const isRaw = (it: any) => {
      if (!it || !it.transaction || !it.meta || it.slot === undefined) return false;
      // Check for signature at top level or in transaction
      const hasSig = it.signature || (it.transaction?.signatures && it.transaction.signatures.length > 0);
      return !!hasSig;
    };

    // Get Anchor coder
    const coder = getCoder();

    let vaultsProcessed = 0;
    let positionsProcessed = 0;
    let activitiesProcessed = 0;

    // Process each item in the webhook payload
    for (const item of items) {
      if (!isRaw(item)) {
        info("Skipping non-raw item", { keys: Object.keys(item || {}) });
        continue;
      }

      // Extract signature - may be top-level or in transaction.signatures[0]
      const signature = item.signature || item.transaction?.signatures?.[0];
      if (!signature) {
        info("Skipping item without signature", { keys: Object.keys(item) });
        continue;
      }

      const slot = item.slot;
      const blockTime = item.blockTime ?? null;
      const keys = item.transaction?.message?.accountKeys ?? [];
      const accountKeys = keys.map((k: any) => typeof k === "string" ? k : k?.pubkey).filter(Boolean);

      // Sanity check: verify transaction exists on this cluster
      try {
        const txCheck = await fetch(cfg.solanaRpcEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [signature, { encoding: "json", commitment: "confirmed" }]
          })
        });
        const txResult = await txCheck.json();
        if (!txResult.result) {
          errorLog("Transaction NOT found on current RPC - cluster mismatch", {
            signature,
            rpcEndpoint: cfg.solanaRpcEndpoint
          });
          continue; // Skip this transaction
        }
      } catch (err) {
        errorLog("Error checking transaction", { signature, error: String(err) });
      }

      // Fetch latest base64 account data (raw payloads don't include it)
      // Use 3 retries with per-key fallback for devnet visibility lag
      const infos = await getMultipleAccounts(accountKeys, { retries: 3 });

      const programAccounts = filterProgramAccounts(infos, cfg.programId);

      // Skip if no program accounts found (not our transaction)
      if (programAccounts.length === 0) {
        continue;
      }

      const decoded = programAccounts.length ? decodeAccounts(coder, programAccounts) : [];

      // Extract actions from logs before checking decoded accounts
      // This is needed to handle closeVault which deletes the account
      const logMessages: string[] = item.meta?.logMessages ?? [];
      const actions = extractActionsFromLogs({ meta: { logMessages }, signature, slot, blockTime } as any);

      // Handle closeVault: Anchor's close constraint deletes the account,
      // so we update vault status in Redis from the cached data
      if (actions.includes("closeVault") && decoded.length === 0) {
        // The deleted vault PDA should be in the null accounts
        const potentialVaultKeys = accountKeys.filter((_: string, i: number) => infos[i] === null);

        for (const vaultPda of potentialVaultKeys) {
          const existing = await getJSON<import("../../types/dto.js").VaultDTO>(kVaultJson(vaultPda));
          if (existing && (existing.status === "Canceled" || existing.status === "Matured")) {

            // Update vault status to Closed
            const closedVault: import("../../types/dto.js").VaultDTO = {
              ...existing,
              status: "Closed",
              slot,
              updatedAt: blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString(),
              updatedAtEpoch: blockTime ?? Math.floor(Date.now() / 1000),
            };

            // Update in Redis with proper indexing
            await Promise.all([
              setJSON(kVaultJson(vaultPda), closedVault),
              zadd(kAuthorityVaultsByUpdated(closedVault.authority), closedVault.updatedAtEpoch, vaultPda),
              zadd(kAuthorityVaultsByUpdated(closedVault.authority, "Closed"), closedVault.updatedAtEpoch, vaultPda),
              // Remove from old status ZSET
              zrem(kAuthorityVaultsByUpdated(closedVault.authority, existing.status), vaultPda),
            ]);

            // Create activity event for vault closure
            const activityDto = toActivityDTO("closeVault", {
              txSig: signature,
              slot: slot,
              blockTime: blockTime,
              vaultPda: vaultPda,
              positionPda: undefined,
              authority: closedVault.authority,
              owner: undefined,
              amount: undefined,
              assetMint: closedVault.assetMint ?? undefined,
            });

            const activityKey = kActivity(signature, activityDto.type, slot);
            const activityTtlSeconds = cfg.activityTtlDays * 24 * 3600;
            const wasNew = await setnx(activityKey, activityDto, { ex: activityTtlSeconds });

            if (wasNew === 1) {
              const score = activityDto.blockTimeEpoch || slot;
              if (activityDto.vaultPda) {
                await zadd(kVaultActivity(activityDto.vaultPda), score, activityKey);
              }
              activitiesProcessed++;
            }

            vaultsProcessed++;
          }
        }

        // Skip to next transaction after handling close
        continue;
      }

      if (decoded.length === 0) {
        continue;
      }

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

      for (const decodedItem of decoded) {
        if (decodedItem.type === "vault") {
          const vaultData = decodedItem.data as import("../../lib/anchor.js").DecodedVault;
          const dto = toVaultDTO(decodedItem.pda, vaultData, slot, blockTime);

          // Get existing vault from pre-fetched map
          const existingVault = oldVaults.get(decodedItem.pda);

          // Prevent race condition: only update if this is newer data (higher slot)
          // If existing vault has a newer slot, skip this update to avoid overwriting with stale data
          if (existingVault && existingVault.slot !== null && dto.slot !== null) {
            if (dto.slot < existingVault.slot) {
              // This update is stale (older slot), skip it
              info("Skipping stale vault update", {
                pda: decodedItem.pda,
                currentSlot: existingVault.slot,
                incomingSlot: dto.slot
              });
              continue; // Skip to next account
            }
          }

          // Batch all vault operations including ZSET for ordering
          // Also write to per-status ZSET for efficient filtered queries
          const vaultOps: Promise<unknown>[] = [
            setJSON(kVaultJson(decodedItem.pda), dto),
            sadd(kVaultsSet(), decodedItem.pda),
            sadd(kAuthorityVaults(dto.authority), decodedItem.pda),
            zadd(kAuthorityVaultsByUpdated(dto.authority), dto.updatedAtEpoch, decodedItem.pda),
            zadd(kAuthorityVaultsByUpdated(dto.authority, dto.status), dto.updatedAtEpoch, decodedItem.pda)
          ];

          // If status changed, remove from old per-status ZSET to prevent stale entries
          const statusChanged = existingVault && existingVault.status !== dto.status;
          if (statusChanged) {
            vaultOps.push(
              zrem(kAuthorityVaultsByUpdated(dto.authority, existingVault.status), decodedItem.pda)
            );
          }

          accountOperations.push(...vaultOps);
          vaultsProcessed++;
        } else if (decodedItem.type === "position") {
          const positionData = decodedItem.data as import("../../lib/anchor.js").DecodedPosition;
          const dto = toPositionDTO(decodedItem.pda, positionData, slot, blockTime);

          // Get existing position from pre-fetched map
          const existingPosition = oldPositions.get(decodedItem.pda);

          // Prevent race condition: only update if this is newer data (higher slot)
          if (existingPosition && existingPosition.slot !== null && dto.slot !== null) {
            if (dto.slot < existingPosition.slot) {
              // This update is stale (older slot), skip it
              info("Skipping stale position update", {
                pda: decodedItem.pda,
                currentSlot: existingPosition.slot,
                incomingSlot: dto.slot
              });
              continue; // Skip to next account
            }
          }

          // Batch all position operations including ZSET for ordering
          accountOperations.push(
            setJSON(kPositionJson(decodedItem.pda), dto),
            sadd(kOwnerPositions(dto.owner), decodedItem.pda),
            zadd(kOwnerPositionsByUpdated(dto.owner), dto.updatedAtEpoch, decodedItem.pda)
          );

          positionsProcessed++;
        }
      }

      // Execute all account operations in parallel
      await batchOperations(() => accountOperations);

      // Create activity events
      // Note: actions and logMessages were already extracted earlier for closeVault handling
      for (const action of actions) {
        // Try to find associated vault/position from decoded accounts
        const vaultItem = decoded.find((d) => d.type === "vault");
        const positionItem = decoded.find((d) => d.type === "position");

        // Extract amount from account deltas
        let amount: string | undefined;
        let assetMint: string | undefined;

        if (vaultItem?.type === "vault") {
          const newVault = vaultItem.data as import("../../lib/anchor.js").DecodedVault;
          // Check for default PublicKey (null mint) like normalize.ts does
          assetMint = newVault.asset_mint.equals(PublicKey.default)
            ? undefined
            : newVault.asset_mint.toBase58();

          const oldVault = oldVaults.get(vaultItem.pda);

          if (oldVault) {
            // Calculate delta based on action type
            if (action === "deposit" || action === "initializeVault") {
              const oldDeposited = BigInt(oldVault.totalDeposited || "0");
              const newDeposited = BigInt(newVault.total_deposited);
              const delta = newDeposited - oldDeposited;
              if (delta > 0n) {
                amount = delta.toString();
              }
            } else if (action === "claim") {
              const oldClaimed = BigInt(oldVault.totalClaimed || "0");
              const newClaimed = BigInt(newVault.total_claimed);
              const delta = newClaimed - oldClaimed;
              if (delta > 0n) {
                amount = delta.toString();
              }
            }
          } else {
            // No previous state - use current total for any deposit-like action
            if ((action === "deposit" || action === "initializeVault") && BigInt(newVault.total_deposited) > 0n) {
              amount = BigInt(newVault.total_deposited).toString();
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
              const newDeposited = BigInt(newPosition.deposited);
              const delta = newDeposited - oldDeposited;
              if (delta > 0n) {
                amount = delta.toString();
              }
            } else if (action === "claim") {
              const oldClaimed = BigInt(oldPosition.claimed || "0");
              const newClaimed = BigInt(newPosition.claimed);
              const delta = newClaimed - oldClaimed;
              if (delta > 0n) {
                amount = delta.toString();
              }
            }
          } else {
            // No previous state - use total for first deposit
            if (action === "deposit" && BigInt(newPosition.deposited) > 0n) {
              amount = BigInt(newPosition.deposited).toString();
            }
          }
        }

        const activityDto = toActivityDTO(action, {
          txSig: signature,
          slot: slot,
          blockTime: blockTime,
          vaultPda: vaultItem?.pda,
          positionPda: positionItem?.pda,
          authority: vaultItem?.type === "vault" ? (vaultItem.data as import("../../lib/anchor.js").DecodedVault).authority.toBase58() : undefined,
          owner: positionItem?.type === "position" ? (positionItem.data as import("../../lib/anchor.js").DecodedPosition).owner.toBase58() : undefined,
          amount,
          assetMint,
        });

        const activityKey = kActivity(signature, activityDto.type, slot);

        // Use SETNX for idempotent writes with configurable TTL to prevent unbounded growth
        const activityTtlSeconds = cfg.activityTtlDays * 24 * 3600;
        const wasNew = await setnx(activityKey, activityDto, { ex: activityTtlSeconds });

        if (wasNew === 1) {
          // Only add to ZSETs if this is a new activity
          // Use blockTimeEpoch for score (fallback to slot if null)
          const score = activityDto.blockTimeEpoch || slot;

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
