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
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { json, error, handleCors } from "../lib/http.js";

const DEVNET_USDT_MINT = "4d79dBszeKpibjrZgiXewW4DCfU2SE4oeiQETbJgnQEh";
const FAUCET_AMOUNT = 1000; // 1000 USDT
const USDT_DECIMALS = 9;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCors(res);
  }

  if (req.method !== "POST") {
    return error(res, 405, "Method not allowed");
  }

  try {
    const { address } = req.body;

    if (!address) {
      return error(res, 400, "Address required");
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

    // Get recipient ATA
    const recipientAta = await getAssociatedTokenAddress(
      mintPubkey,
      recipientPubkey
    );

    const transaction = new Transaction();

    // Create ATA if doesn't exist
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

    // Mint tokens
    const amount = BigInt(FAUCET_AMOUNT * 10 ** USDT_DECIMALS);
    transaction.add(
      createMintToInstruction(
        mintPubkey,
        recipientAta,
        faucetKeypair.publicKey,
        amount
      )
    );

    // Send transaction
    const signature = await connection.sendTransaction(transaction, [faucetKeypair]);
    await connection.confirmTransaction(signature, "confirmed");

    return json(res, 200, {
      success: true,
      signature,
      amount: FAUCET_AMOUNT,
    });
  } catch (err) {
    console.error("Faucet error:", err);
    return error(
      res,
      500,
      "Faucet failed",
      err instanceof Error ? err.message : "Unknown error"
    );
  }
}
