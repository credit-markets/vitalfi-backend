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
 * Decoded Vault account (snake_case from Anchor IDL)
 *
 * Note: Anchor deserializes Rust enum variants as objects with PascalCase keys
 */
export interface DecodedVault {
  version: number;
  authority: PublicKey;
  vault_id: bigint;
  asset_mint: PublicKey;
  vault_token: PublicKey;
  cap: bigint;
  target_apy_bps: number;
  funding_end_ts: bigint;
  maturity_ts: bigint;
  min_deposit: bigint;
  status: { Funding?: {}; Active?: {}; Canceled?: {}; Matured?: {}; Closed?: {} };
  total_deposited: bigint;
  total_claimed: bigint;
  payout_num: bigint;
  payout_den: bigint;
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
