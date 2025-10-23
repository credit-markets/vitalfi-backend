/**
 * Normalization Helpers
 *
 * Convert decoded Anchor accounts to compact DTOs for storage.
 */

import { PublicKey } from "@solana/web3.js";
import type { DecodedVault, DecodedPosition } from "./anchor.js";
import type { VaultDTO, PositionDTO, ActivityDTO, VaultStatus, ActivityType } from "../types/dto.js";
import { cfg } from "./env.js";
import { errorLog } from "./logger.js";

/**
 * Derive Vault Token Account PDA
 * Seeds: ["vault_token", vault]
 */
function getVaultTokenAccount(vaultPda: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token"), new PublicKey(vaultPda).toBuffer()],
    new PublicKey(cfg.programId)
  );
  return pda.toBase58();
}

/**
 * Map Anchor vault status enum to DTO string
 */
function mapVaultStatus(status: DecodedVault["status"]): VaultStatus {
  if ("funding" in status) return "Funding";
  if ("active" in status) return "Active";
  if ("canceled" in status) return "Canceled";
  if ("matured" in status) return "Matured";
  return "Funding"; // Default fallback
}

/**
 * Convert decoded Vault to DTO
 */
export function toVaultDTO(
  pda: string,
  decoded: DecodedVault,
  slot: number,
  blockTime?: number | null
): VaultDTO {
  const now = Date.now();
  const updatedAtEpoch = blockTime || Math.floor(now / 1000);

  return {
    vaultPda: pda,
    vaultTokenAccount: getVaultTokenAccount(pda),
    authority: decoded.authority.toBase58(),
    vaultId: decoded.vault_id.toString(),
    assetMint: decoded.asset_mint.toBase58(),
    status: mapVaultStatus(decoded.status),
    cap: decoded.cap.toString(),
    totalDeposited: decoded.total_deposited.toString(),
    totalClaimed: decoded.total_claimed.toString(),
    targetApyBps: decoded.target_apy_bps,
    minDeposit: decoded.min_deposit.toString(),
    fundingEndTs: decoded.funding_end_ts.toString(),
    maturityTs: decoded.maturity_ts.toString(),
    payoutNum: decoded.payout_num.toString(),
    payoutDen: decoded.payout_den.toString(),
    slot,
    updatedAt: new Date(updatedAtEpoch * 1000).toISOString(),
    updatedAtEpoch,
  };
}

/**
 * Convert decoded Position to DTO
 */
export function toPositionDTO(
  pda: string,
  decoded: DecodedPosition,
  slot: number,
  blockTime?: number | null
): PositionDTO {
  const now = Date.now();
  const updatedAtEpoch = blockTime || Math.floor(now / 1000);
  
  return {
    positionPda: pda,
    vaultPda: decoded.vault.toBase58(),
    owner: decoded.owner.toBase58(),
    deposited: decoded.deposited.toString(),
    claimed: decoded.claimed.toString(),
    slot,
    updatedAt: new Date(updatedAtEpoch * 1000).toISOString(),
    updatedAtEpoch,
  };
}

/**
 * Map Solana instruction names to ActivityType enum
 */
const ACTION_TYPE_MAP: Record<string, ActivityType> = {
  initializeVault: "vault_created",
  deposit: "deposit",
  claim: "claim",
  finalizeFunding: "funding_finalized",
  matureVault: "matured",
  cancelVault: "canceled",
  authorityWithdraw: "authority_withdraw",
  // Note: position_created is inferred when position appears in accounts
};

/**
 * Convert action and context to ActivityDTO
 */
export function toActivityDTO(
  action: string,
  context: {
    txSig: string;
    slot: number;
    blockTime: number | null;
    vaultPda?: string;
    positionPda?: string;
    authority?: string;
    owner?: string;
    amount?: string;
    assetMint?: string;
  }
): ActivityDTO {
  // Map action names to ActivityType with fallback logging
  const type = ACTION_TYPE_MAP[action];

  if (!type) {
    errorLog("Unknown action type in activity", { action, fallback: "vault_created" });
  }

  const blockTimeEpoch = context.blockTime;
  const activityType = type || "vault_created";

  return {
    id: `${context.txSig}:${activityType}:${context.slot}`,
    txSig: context.txSig,
    slot: context.slot,
    blockTime: blockTimeEpoch ? new Date(blockTimeEpoch * 1000).toISOString() : null,
    blockTimeEpoch,
    type: activityType,
    vaultPda: context.vaultPda || null,
    positionPda: context.positionPda || null,
    authority: context.authority || null,
    owner: context.owner || null,
    amount: context.amount || null,
    assetMint: context.assetMint || null,
  };
}
