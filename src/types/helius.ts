/**
 * Helius Webhook Types
 *
 * Minimal type definitions for the webhook payloads we receive from Helius.
 */

export interface HeliusAccountData {
  account: string; // Base58 pubkey
  data: string; // Base64 encoded account data
  owner: string; // Base58 program ID
}

export interface HeliusMeta {
  logMessages?: string[];
  err?: unknown;
}

export interface HeliusWebhookPayload {
  accountData: HeliusAccountData[];
  signature: string;
  slot: number;
  blockTime: number | null; // Unix epoch seconds, null if not finalized
  meta?: HeliusMeta;
}
