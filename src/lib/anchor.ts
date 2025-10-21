/**
 * Anchor Helpers
 *
 * Load IDL and create BorshCoder for account decoding.
 */

import { BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createRequire } from "module";

// Use createRequire to load JSON in ESM context (works in Node.js without import assertions)
const require = createRequire(import.meta.url);
const idlJson = require("@pollum-io/vitalfi-programs/idl");

/**
 * Get Anchor BorshCoder for the VitalFi program
 */
export function getCoder(): BorshCoder {
  return new BorshCoder(idlJson);
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
