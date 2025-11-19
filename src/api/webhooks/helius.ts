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
import { extractActionsFromLogs, decodeAccounts } from "../../lib/helius.js";
import { getCoder } from "../../lib/anchor.js";
import { toVaultDTO, toPositionDTO, toActivityDTO } from "../../lib/normalize.js";
import { setJSON, zadd, zrem, setnx, getJSON, pipeline, prefixKey } from "../../lib/kv.js";
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
import { recordWebhook } from "../../lib/metrics.js";
import { getMultipleAccounts, filterProgramAccounts } from "../../lib/solana.js";
import { rawWebhookPayloadSchema } from "../../types/helius.js";

// Configure to read raw body
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
  const start = Date.now();

  try {
    if (req.method !== "POST") {
      return error(res, 405, "Method not allowed");
    }

    // Read raw body with size validation
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

    // Verify shared secret from Authorization header
    // Use timing-safe comparison to prevent timing attacks
    const token = req.headers.authorization as string | undefined;
    if (!token) {
      errorLog("Missing authentication token in webhook request");
      return error(res, 401, "Invalid token");
    }

    try {
      const tokenBuffer = Buffer.from(token);
      const secretBuffer = Buffer.from(cfg.heliusSecret);
      if (tokenBuffer.length !== secretBuffer.length || !timingSafeEqual(tokenBuffer, secretBuffer)) {
        errorLog("Invalid authentication token in webhook request");
        return error(res, 401, "Invalid token");
      }
    } catch {
      errorLog("Token comparison failed");
      return error(res, 401, "Invalid token");
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

    // Validate each item against schema
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;

      const parsed = rawWebhookPayloadSchema.safeParse(item);
      if (!parsed.success) {
        errorLog("Webhook payload validation failed", new Error(JSON.stringify(parsed.error.issues)));
        return error(res, 400, "Invalid webhook payload", parsed.error.issues);
      }
    }

    // Get Anchor coder
    const coder = getCoder();

    let vaultsProcessed = 0;
    let positionsProcessed = 0;
    let activitiesProcessed = 0;

    // Process each item in the webhook payload
    for (const item of items) {
      // Skip non-object items
      if (!item || typeof item !== 'object') continue;

      // Extract signature from transaction.signatures[0]
      const signature = item.transaction?.signatures?.[0];
      if (!signature) {
        info("Skipping item without signature", { keys: Object.keys(item) });
        continue;
      }

      const slot = item.slot;
      const blockTime = item.blockTime ?? null;
      const keys = item.transaction?.message?.accountKeys ?? [];
      const accountKeys = keys.map((k: any) => typeof k === "string" ? k : k?.pubkey).filter(Boolean);

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
            const wasNew = await setnx(activityKey, activityDto);

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

      // Handle claim with position closure: Anchor's close constraint deletes the position,
      // so we update position status in Redis from the cached data
      if (actions.includes("claim")) {
        // Find null accounts that could be deleted positions
        const potentialPositionKeys = accountKeys.filter((_: string, i: number) => infos[i] === null);

        for (const positionPda of potentialPositionKeys) {
          const existing = await getJSON<import("../../types/dto.js").PositionDTO>(kPositionJson(positionPda));
          if (existing && existing.deposited && BigInt(existing.deposited) > 0) {
            // Get the vault to calculate payout amount
            const vault = await getJSON<import("../../types/dto.js").VaultDTO>(kVaultJson(existing.vaultPda));

            let claimAmount: string;
            if (vault && vault.status === "Canceled") {
              // Refund: claimed = deposited
              claimAmount = existing.deposited;
            } else if (vault && vault.payoutNum && vault.payoutDen && BigInt(vault.payoutDen) > 0) {
              // Calculate payout: deposited * payoutNum / payoutDen
              const deposited = BigInt(existing.deposited);
              const num = BigInt(vault.payoutNum);
              const den = BigInt(vault.payoutDen);
              claimAmount = ((deposited * num) / den).toString();
            } else {
              // Fallback: use deposited amount
              claimAmount = existing.deposited;
            }

            // Update position to mark as fully claimed
            const claimedPosition: import("../../types/dto.js").PositionDTO = {
              ...existing,
              claimed: claimAmount,
              slot,
              updatedAt: blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString(),
              updatedAtEpoch: blockTime ?? Math.floor(Date.now() / 1000),
            };

            // Update in Redis with proper indexing
            await Promise.all([
              setJSON(kPositionJson(positionPda), claimedPosition),
              zadd(kOwnerPositionsByUpdated(claimedPosition.owner), claimedPosition.updatedAtEpoch, positionPda),
            ]);

            // Create activity event for claim
            const activityDto = toActivityDTO("claim", {
              txSig: signature,
              slot: slot,
              blockTime: blockTime,
              vaultPda: existing.vaultPda,
              positionPda: positionPda,
              authority: vault?.authority,
              owner: existing.owner,
              amount: claimAmount,
              assetMint: vault?.assetMint ?? undefined,
            });

            const activityKey = kActivity(signature, activityDto.type, slot);
            const wasNew = await setnx(activityKey, activityDto);

            if (wasNew === 1) {
              const score = activityDto.blockTimeEpoch || slot;
              const zsetOps: Promise<unknown>[] = [];

              if (activityDto.vaultPda) {
                zsetOps.push(zadd(kVaultActivity(activityDto.vaultPda), score, activityKey));
              }
              if (activityDto.owner) {
                zsetOps.push(zadd(kOwnerActivity(activityDto.owner), score, activityKey));
              }

              await Promise.all(zsetOps);
              activitiesProcessed++;
            }

            positionsProcessed++;

            info("Processed claim with position closure", {
              positionPda,
              owner: existing.owner,
              vaultPda: existing.vaultPda,
              claimAmount,
            });
          }
        }

        // If we processed deleted positions for claim, skip normal processing
        // But only if there are no other decoded accounts to process
        if (decoded.length === 0) {
          continue;
        }
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

      // Process each decoded account with Redis pipelining for better performance
      // Collect all operations to execute in a single MULTI/EXEC
      interface PipelineOp {
        type: 'set' | 'sadd' | 'zadd' | 'zrem';
        key: string;
        value?: string;
        score?: number;
        members?: string[];
      }
      const pipelineOps: PipelineOp[] = [];

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

          // Queue all vault operations for pipeline
          pipelineOps.push(
            { type: 'set', key: kVaultJson(decodedItem.pda), value: JSON.stringify(dto) },
            { type: 'sadd', key: kVaultsSet(), members: [decodedItem.pda] },
            { type: 'sadd', key: kAuthorityVaults(dto.authority), members: [decodedItem.pda] },
            { type: 'zadd', key: kAuthorityVaultsByUpdated(dto.authority), score: dto.updatedAtEpoch, value: decodedItem.pda },
            { type: 'zadd', key: kAuthorityVaultsByUpdated(dto.authority, dto.status), score: dto.updatedAtEpoch, value: decodedItem.pda }
          );

          // If status changed, remove from old per-status ZSET to prevent stale entries
          const statusChanged = existingVault && existingVault.status !== dto.status;
          if (statusChanged) {
            pipelineOps.push(
              { type: 'zrem', key: kAuthorityVaultsByUpdated(dto.authority, existingVault.status), members: [decodedItem.pda] }
            );
          }

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

          // Queue all position operations for pipeline
          pipelineOps.push(
            { type: 'set', key: kPositionJson(decodedItem.pda), value: JSON.stringify(dto) },
            { type: 'sadd', key: kOwnerPositions(dto.owner), members: [decodedItem.pda] },
            { type: 'zadd', key: kOwnerPositionsByUpdated(dto.owner), score: dto.updatedAtEpoch, value: decodedItem.pda }
          );

          positionsProcessed++;
        }
      }

      // Execute all account operations in a single Redis pipeline (MULTI/EXEC)
      if (pipelineOps.length > 0) {
        await pipeline((pipe) => {
          for (const op of pipelineOps) {
            const key = prefixKey(op.key);
            switch (op.type) {
              case 'set':
                pipe.set(key, op.value!);
                break;
              case 'sadd':
                pipe.sAdd(key, op.members!);
                break;
              case 'zadd':
                pipe.zAdd(key, { score: op.score!, value: op.value! });
                break;
              case 'zrem':
                pipe.zRem(key, op.members!);
                break;
            }
          }
        });
      }

      // Create activity events
      // Note: actions and logMessages were already extracted earlier for closeVault handling
      for (const action of actions) {
        // Claim activity is always handled by the deleted position handler above
        // since positions are always closed on claim
        if (action === "claim") {
          continue;
        }

        // Try to find associated vault/position from decoded accounts
        const vaultItem = decoded.find((d) => d.type === "vault");
        const positionItem = decoded.find((d) => d.type === "position");

        // Extract amount from account deltas
        let amount: string | undefined;
        let assetMint: string | null | undefined;

        if (vaultItem?.type === "vault") {
          const newVault = vaultItem.data as import("../../lib/anchor.js").DecodedVault;
          // Check for default PublicKey (null mint) like normalize.ts does
          assetMint = newVault.asset_mint.equals(PublicKey.default)
            ? null
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
            } else if (action === "matureVault") {
              // For matureVault, track the payout_num which represents the total amount
              // returned by authority at maturity (used as numerator in payout ratio)
              if (newVault.payout_num > 0n) {
                amount = newVault.payout_num.toString();
              }
            }
          } else {
            // No previous state - use current total for any deposit-like action
            if ((action === "deposit" || action === "initializeVault") && BigInt(newVault.total_deposited) > 0n) {
              amount = BigInt(newVault.total_deposited).toString();
            } else if (action === "matureVault" && newVault.payout_num > 0n) {
              // Track the total amount returned by authority at maturity
              amount = newVault.payout_num.toString();
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

        // Use blockTimeEpoch for score (fallback to slot if null)
        const score = activityDto.blockTimeEpoch || slot;

        try {
          // Atomic pipeline: create activity + index in ZSETs together
          // All operations succeed or fail as a unit
          const results = await pipeline((pipe) => {
            // SETNX for idempotent activity creation
            pipe.set(prefixKey(activityKey), JSON.stringify(activityDto), { NX: true });

            // Add to vault activity ZSET
            if (activityDto.vaultPda) {
              pipe.zAdd(prefixKey(kVaultActivity(activityDto.vaultPda)), {
                score,
                value: activityKey
              });
            }

            // Add to owner activity ZSET
            if (activityDto.owner) {
              pipe.zAdd(prefixKey(kOwnerActivity(activityDto.owner)), {
                score,
                value: activityKey
              });
            }
          });

          // Check if activity was newly created (SETNX returns "OK" if set, null if exists)
          const wasNew = results[0] === "OK";
          if (wasNew) {
            activitiesProcessed++;
          }
        } catch (err) {
          const indexError = err instanceof Error ? err : new Error(String(err));
          errorLog("Failed to create/index activity atomically", { activityKey, error: indexError });
          // Re-throw to fail the webhook - Helius will retry
          throw err;
        }
      }
    }

    const duration = Date.now() - start;
    info("Webhook processed successfully", {
      vaults: vaultsProcessed,
      positions: positionsProcessed,
      activities: activitiesProcessed,
      durationMs: duration,
    });

    recordWebhook(duration, vaultsProcessed, positionsProcessed, activitiesProcessed);

    return json(res, 200, {
      ok: true,
      processed: {
        vaults: vaultsProcessed,
        positions: positionsProcessed,
        activities: activitiesProcessed,
      },
    });
  } catch (err) {
    const duration = Date.now() - start;
    const processingError = err instanceof Error ? err : new Error(String(err));
    errorLog("Webhook processing failed", processingError);
    recordWebhook(duration, 0, 0, 0, true);
    return error(res, 500, "Internal server error");
  }
}
