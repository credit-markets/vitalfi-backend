/**
 * Helius Webhook Types
 *
 * Type definitions for raw webhook payloads from Helius.
 * Raw webhooks send Solana transaction objects (similar to getTransaction).
 *
 * Note: Helius does NOT send base64 account data in webhooks.
 * We must fetch account data separately via RPC after receiving the webhook.
 */

import { z } from "zod";

// Raw webhook format - matches actual Helius payload
export interface RawTransactionMessage {
  accountKeys: Array<string | { pubkey: string; signer: boolean; writable: boolean }>;
  instructions: any[];
  recentBlockhash: string;
}

export interface RawTransaction {
  signatures: string[];
  message: RawTransactionMessage;
}

export interface HeliusMeta {
  logMessages?: string[];
  err?: unknown;
  fee?: number;
  preBalances?: number[];
  postBalances?: number[];
  innerInstructions?: any[];
  preTokenBalances?: any[];
  postTokenBalances?: any[];
  rewards?: any[];
}

export interface RawWebhookPayload {
  blockTime: number | null; // Unix epoch seconds, null if not finalized
  indexWithinBlock: number;
  slot: number;
  transaction: RawTransaction;
  meta: HeliusMeta;
  version?: string | number;
}

// Zod schema for raw webhook payload validation
export const rawWebhookPayloadSchema = z.object({
  blockTime: z.number().int().nullable(),
  indexWithinBlock: z.number().int().nonnegative(),
  slot: z.number().int().nonnegative(),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({
      accountKeys: z.array(z.union([
        z.string(),
        z.object({
          pubkey: z.string(),
          signer: z.boolean(),
          writable: z.boolean(),
        }),
      ])),
      instructions: z.array(z.any()),
      recentBlockhash: z.string(),
    }).passthrough(),
  }).passthrough(),
  meta: z.object({
    logMessages: z.array(z.string()).optional(),
    err: z.unknown().optional(),
    fee: z.number().optional(),
    preBalances: z.array(z.number()).optional(),
    postBalances: z.array(z.number()).optional(),
    innerInstructions: z.array(z.any()).optional(),
    preTokenBalances: z.array(z.any()).optional(),
    postTokenBalances: z.array(z.any()).optional(),
    rewards: z.array(z.any()).optional(),
  }).passthrough(),
  version: z.union([z.string(), z.number()]).optional(),
});
