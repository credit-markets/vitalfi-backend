/**
 * Anchor Helpers
 *
 * Load IDL and create BorshCoder for account decoding.
 */

import { BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
// @ts-expect-error IDL import from published package
import idlJson from "@pollum-io/vitalfi-programs/idl" assert { type: "json" };

/**
 * Get Anchor BorshCoder for the VitalFi program
 */
export function getCoder(): BorshCoder {
  // Cast to any to avoid type issues with IDL version
  return new BorshCoder(idlJson as any);
}

/**
 * Decoded Vault account
 */
export interface DecodedVault {
  version: number;
  authority: PublicKey;
  vaultId: bigint;
  assetMint: PublicKey;
  vaultToken: PublicKey;
  cap: bigint;
  targetApyBps: number;
  fundingEndTs: bigint;
  maturityTs: bigint;
  minDeposit: bigint;
  status: { funding?: {}; active?: {}; canceled?: {}; matured?: {}; closed?: {} };
  totalDeposited: bigint;
  totalClaimed: bigint;
  payoutNum: bigint;
  payoutDen: bigint;
  bump: number;
}

/**
 * Decoded Position account
 */
export interface DecodedPosition {
  vault: PublicKey;
  owner: PublicKey;
  deposited: bigint;
  claimed: bigint;
  bump: number;
}
