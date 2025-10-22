/**
 * Data Transfer Objects (DTOs)
 *
 * Compact JSON representations stored in KV.
 * All numeric types stored as strings to avoid JavaScript precision issues with u64.
 */

export type VaultStatus = "Funding" | "Active" | "Matured" | "Canceled";

export type VaultDTO = {
  vaultPda: string;
  vaultTokenAccount: string;
  authority: string;
  vaultId: string;
  assetMint: string | null;
  status: VaultStatus;
  cap: string | null;
  totalDeposited: string | null;
  totalClaimed: string | null;
  targetApyBps: number | null;
  minDeposit: string | null;
  fundingEndTs: string | null;
  maturityTs: string | null;
  payoutNum: string | null; // Payout numerator (u128 as string)
  payoutDen: string | null; // Payout denominator (u128 as string)
  slot: number | null;
  updatedAt: string; // ISO 8601
  updatedAtEpoch: number; // Unix epoch seconds for cursor pagination
};

export type PositionDTO = {
  positionPda: string;
  vaultPda: string;
  owner: string;
  deposited: string | null;
  claimed: string | null;
  slot: number | null;
  updatedAt: string; // ISO 8601
  updatedAtEpoch: number; // Unix epoch seconds for cursor pagination
};

export type ActivityType =
  | "deposit"
  | "claim"
  | "funding_finalized"
  | "authority_withdraw"
  | "matured"
  | "canceled"
  | "vault_created"
  | "position_created";

export type ActivityDTO = {
  id: string; // `${txSig}:${type}:${slot}`
  txSig: string;
  slot: number;
  blockTime: string | null; // ISO 8601 or null
  blockTimeEpoch: number | null; // Unix epoch seconds for ZSET scores
  type: ActivityType;
  vaultPda: string | null;
  positionPda: string | null;
  authority: string | null;
  owner: string | null;
  amount: string | null;
  assetMint: string | null;
};
