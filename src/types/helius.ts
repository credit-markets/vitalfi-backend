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

// Raw webhook format - matches Solana getTransaction response
export interface RawTransactionMessage {
  accountKeys: string[]; // Array of Base58 pubkeys involved in tx
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
  signature: string;
  slot: number;
  blockTime: number | null; // Unix epoch seconds, null if not finalized
  transaction: RawTransaction;
  meta: HeliusMeta;
}

// Zod schema for raw webhook payload validation
export const rawWebhookPayloadSchema = z.object({
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({
      accountKeys: z.array(z.string()),
      instructions: z.array(z.any()),
      recentBlockhash: z.string(),
    }).passthrough(), // Allow additional fields
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
});

// Export as main schema (for backwards compatibility)
export const heliusWebhookPayloadSchema = rawWebhookPayloadSchema;
