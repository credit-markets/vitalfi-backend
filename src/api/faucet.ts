/**
 * Faucet API - Devnet USDT Airdrop
 * POST /api/faucet
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import { json, error, handleCors } from "../lib/http.js";
import { checkRateLimit, getClientIp, setRateLimitHeaders } from "../lib/rate-limit.js";
import { logRequest, errorLog } from "../lib/logger.js";

const DEVNET_USDT_MINT = "4d79dBszeKpibjrZgiXewW4DCfU2SE4oeiQETbJgnQEh";
const FAUCET_AMOUNT = 1000; // 1000 USDT
const USDT_DECIMALS = 9;
const MIN_SOL_FOR_TX = 5_000_000; // ~0.005 SOL for transaction fees

// Strict rate limit for faucet: 3 requests per hour per IP
const FAUCET_RATE_LIMIT = {
  limit: 3,
  windowSeconds: 3600,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCors(res);
  }

  if (req.method !== "POST") {
    return error(res, 405, "Method not allowed");
  }

  try {
    // Strict rate limiting for faucet (3 per hour per IP)
    const clientIp = getClientIp(req.headers as Record<string, string | string[] | undefined>);
    const rateLimitResult = await checkRateLimit(`faucet:ip:${clientIp}`, FAUCET_RATE_LIMIT);
    setRateLimitHeaders(res, rateLimitResult, FAUCET_RATE_LIMIT);

    if (!rateLimitResult.allowed) {
      logRequest("POST", "/api/faucet", 429, Date.now() - start);
      return error(res, 429, "Too many faucet requests. Please try again later.");
    }

    const { address } = req.body;

    if (!address) {
      return error(res, 400, "Address required");
    }

    // Additional rate limit per wallet address (1 per day)
    const addressRateLimit = await checkRateLimit(`faucet:addr:${address}`, {
      limit: 1,
      windowSeconds: 86400, // 24 hours
    });

    if (!addressRateLimit.allowed) {
      logRequest("POST", "/api/faucet", 429, Date.now() - start);
      return error(res, 429, "This wallet already received tokens today. Please try again tomorrow.");
    }

    // Validate address
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(address);
    } catch {
      return error(res, 400, "Invalid Solana address");
    }

    // Check if faucet keypair is configured
    const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
    if (!faucetPrivateKey) {
      return error(res, 503, "Faucet not configured");
    }

    // Initialize
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const faucetKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(faucetPrivateKey))
    );
    const mintPubkey = new PublicKey(DEVNET_USDT_MINT);

    // Check faucet SOL balance for transaction fees
    const solBalance = await connection.getBalance(faucetKeypair.publicKey);
    if (solBalance < MIN_SOL_FOR_TX) {
      errorLog("Faucet insufficient SOL for fees", {
        available: solBalance,
        required: MIN_SOL_FOR_TX
      });
      return error(res, 503, "Faucet temporarily unavailable. Please try again later.");
    }

    // Get faucet's token account (treasury)
    const faucetAta = await getAssociatedTokenAddress(
      mintPubkey,
      faucetKeypair.publicKey
    );

    // Check faucet balance before proceeding
    const amount = BigInt(FAUCET_AMOUNT * 10 ** USDT_DECIMALS);
    try {
      const faucetAccount = await getAccount(connection, faucetAta);
      if (faucetAccount.amount < amount) {
        errorLog("Faucet insufficient balance", {
          available: faucetAccount.amount.toString(),
          required: amount.toString()
        });
        return error(res, 503, "Faucet temporarily unavailable. Please try again later.");
      }
    } catch (err) {
      errorLog("Faucet account not found", err);
      return error(res, 503, "Faucet not configured properly");
    }

    // Get recipient ATA
    const recipientAta = await getAssociatedTokenAddress(
      mintPubkey,
      recipientPubkey
    );

    const transaction = new Transaction();

    // Create recipient ATA if doesn't exist
    const ataInfo = await connection.getAccountInfo(recipientAta);
    if (!ataInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          faucetKeypair.publicKey,
          recipientAta,
          recipientPubkey,
          mintPubkey
        )
      );
    }

    // Transfer tokens from faucet treasury to recipient
    transaction.add(
      createTransferInstruction(
        faucetAta,
        recipientAta,
        faucetKeypair.publicKey,
        amount
      )
    );

    // Send transaction
    const signature = await connection.sendTransaction(transaction, [faucetKeypair]);
    await connection.confirmTransaction(signature, "finalized");

    logRequest("POST", "/api/faucet", 200, Date.now() - start);
    return json(res, 200, {
      success: true,
      signature,
      amount: FAUCET_AMOUNT,
    });
  } catch (err) {
    errorLog("Faucet error", err);
    logRequest("POST", "/api/faucet", 500, Date.now() - start);
    return error(
      res,
      500,
      "Faucet failed",
      err instanceof Error ? err.message : "Unknown error"
    );
  }
}
