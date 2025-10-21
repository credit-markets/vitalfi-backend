/**
 * Helius Webhook Handler
 *
 * POST /api/webhooks/helius?token={secret}
 *
 * Receives account update events from Helius, decodes with Anchor,
 * normalizes to DTOs, and writes to KV with indexes.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json, error } from "../../lib/http.js";
import { verifyHeliusSignature, extractActionsFromLogs, decodeAccounts } from "../../lib/helius.js";
import { getCoder } from "../../lib/anchor.js";
import { toVaultDTO, toPositionDTO, toActivityDTO } from "../../lib/normalize.js";
import { setJSON, sadd, zadd, setnx } from "../../lib/kv.js";
import {
  kVaultJson,
  kVaultsSet,
  kAuthorityVaults,
  kPositionJson,
  kOwnerPositions,
  kVaultActivity,
  kOwnerActivity,
  kActivity,
} from "../../lib/keys.js";
import { cfg } from "../../lib/env.js";
import { info, errorLog } from "../../lib/logger.js";
import type { HeliusWebhookPayload } from "../../types/helius.js";

// Configure to read raw body for HMAC verification
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Read raw body from request stream
 */
async function getRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
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

    // Read raw body for HMAC verification
    const rawBody = await getRawBody(req);

    // Verify token from query param OR authentication header
    const token = (req.query.token as string | undefined) ||
                  (req.headers.authorization as string | undefined) ||
                  (req.headers["authentication"] as string | undefined);

    if (token !== cfg.heliusSecret) {
      errorLog("Invalid token in webhook request");
      return error(res, 401, "Invalid token");
    }

    // Verify HMAC signature
    const signature = req.headers["x-helius-signature"] as string | undefined;
    if (!signature || !verifyHeliusSignature(signature, rawBody)) {
      errorLog("Invalid HMAC signature in webhook request");
      return error(res, 401, "Invalid signature");
    }

    // Parse JSON payload
    const payload: HeliusWebhookPayload = JSON.parse(rawBody);

    info("Received Helius webhook", {
      signature: payload.signature,
      slot: payload.slot,
      accountCount: payload.accountData.length,
    });

    // Get Anchor coder
    const coder = getCoder();

    // Decode accounts
    const decoded = decodeAccounts(coder, payload.accountData);

    let vaultsProcessed = 0;
    let positionsProcessed = 0;

    // Process each decoded account
    for (const item of decoded) {
      if (item.type === "vault") {
        const vaultData = item.data as import("../../lib/anchor.js").DecodedVault;
        const dto = toVaultDTO(item.pda, vaultData, payload.slot, payload.blockTime);

        // Write vault JSON
        await setJSON(kVaultJson(item.pda), dto);

        // Add to global vaults set
        await sadd(kVaultsSet(), item.pda);

        // Add to authority's vaults set
        await sadd(kAuthorityVaults(dto.authority), item.pda);

        vaultsProcessed++;
      } else if (item.type === "position") {
        const positionData = item.data as import("../../lib/anchor.js").DecodedPosition;
        const dto = toPositionDTO(item.pda, positionData, payload.slot, payload.blockTime);

        // Write position JSON
        await setJSON(kPositionJson(item.pda), dto);

        // Add to owner's positions set
        await sadd(kOwnerPositions(dto.owner), item.pda);

        positionsProcessed++;
      }
    }

    // Extract actions from logs
    const actions = extractActionsFromLogs(payload);

    let activitiesProcessed = 0;

    // Create activity events
    for (const action of actions) {
      // Try to find associated vault/position from decoded accounts
      const vaultItem = decoded.find((d) => d.type === "vault");
      const positionItem = decoded.find((d) => d.type === "position");

      const activityDto = toActivityDTO(action, {
        txSig: payload.signature,
        slot: payload.slot,
        blockTime: payload.blockTime,
        vaultPda: vaultItem?.pda,
        positionPda: positionItem?.pda,
        authority: vaultItem?.type === "vault" ? (vaultItem.data as import("../../lib/anchor.js").DecodedVault).authority.toBase58() : undefined,
        owner: positionItem?.type === "position" ? (positionItem.data as import("../../lib/anchor.js").DecodedPosition).owner.toBase58() : undefined,
        // TODO: Extract amount from logs if available
      });

      const activityKey = kActivity(payload.signature, activityDto.type, payload.slot);

      // Use SETNX for idempotent writes (dedupe on retries)
      const wasNew = await setnx(activityKey, activityDto);

      if (wasNew === 1) {
        // Only add to ZSETs if this is a new activity
        const score = payload.blockTime || payload.slot; // Fallback to slot if blockTime null

        // Add to vault activity ZSET
        if (activityDto.vaultPda) {
          await zadd(kVaultActivity(activityDto.vaultPda), score, activityKey);
        }

        // Add to owner activity ZSET
        if (activityDto.owner) {
          await zadd(kOwnerActivity(activityDto.owner), score, activityKey);
        }

        activitiesProcessed++;
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
    errorLog("Webhook processing failed", err);
    return error(res, 500, "Internal server error");
  }
}
