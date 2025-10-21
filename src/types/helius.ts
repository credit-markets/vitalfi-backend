/**
 * Helius Webhook Types
 *
 * Minimal type definitions for the webhook payloads we receive from Helius.
 */

import { z } from "zod";

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

// Zod schema for webhook payload validation
export const heliusAccountDataSchema = z.object({
  account: z.string().min(1),
  data: z.string().min(1),
  owner: z.string().min(1),
});

export const heliusMetaSchema = z.object({
  logMessages: z.array(z.string()).optional(),
  err: z.unknown().optional(),
});

export const heliusWebhookPayloadSchema = z.object({
  accountData: z.array(heliusAccountDataSchema),
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  meta: heliusMetaSchema.optional(),
});
