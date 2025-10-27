/**
 * Solana RPC Helpers
 *
 * Utilities for fetching account data from Solana RPC.
 */

import { cfg } from "./env.js";

export interface AccountInfo {
  pubkey: string; // Base58 pubkey
  data: string; // Base64 encoded account data
  owner: string; // Base58 program ID
  lamports: number;
  executable: boolean;
  rentEpoch: number;
}

/**
 * Extract base64 data from RPC response (handles both string and [string, "base64"] formats)
 */
function extractBase64(data: any): string | null {
  if (!data) return null;
  if (typeof data === "string") return data;
  if (Array.isArray(data) && typeof data[0] === "string") return data[0];
  return null;
}

/**
 * Fetch multiple accounts from Solana RPC with per-key fallback for nulls
 *
 * @param pubkeys - Array of Base58 pubkeys to fetch
 * @param options - Options including retry count
 * @returns Array of account info (null for accounts that don't exist)
 */
export async function getMultipleAccounts(
  pubkeys: string[],
  options?: { retries?: number }
): Promise<(AccountInfo | null)[]> {
  if (pubkeys.length === 0) return [];

  const retries = options?.retries ?? 2;

  // First attempt: batch fetch
  const response = await fetch(cfg.solanaRpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [
        pubkeys,
        {
          encoding: "base64",
          commitment: "confirmed", // Use confirmed for faster visibility
        },
      ],
    }),
  });

  const json = await response.json();

  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }

  // Map RPC response to our AccountInfo format
  let infos = json.result.value.map((account: any, index: number) => {
    if (!account) return null;

    const dataB64 = extractBase64(account.data);
    if (!dataB64) return null;

    return {
      pubkey: pubkeys[index],
      data: dataB64,
      owner: account.owner,
      lamports: account.lamports,
      executable: account.executable,
      rentEpoch: account.rentEpoch,
    };
  });

  // Find null indices
  let nullIndices = infos
    .map((info: AccountInfo | null, i: number) => (info ? -1 : i))
    .filter((i: number) => i >= 0);

  // Retry null accounts individually with backoff
  for (let attempt = 0; nullIndices.length > 0 && attempt < retries; attempt++) {
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));

    // Fetch each null account individually
    await Promise.all(
      nullIndices.map(async (i: number) => {
        try {
          const singleResponse = await fetch(cfg.solanaRpcEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getAccountInfo",
              params: [
                pubkeys[i],
                {
                  encoding: "base64",
                  commitment: "confirmed", // Use confirmed for faster visibility
                },
              ],
            }),
          });

          const singleJson = await singleResponse.json();
          if (singleJson.result?.value) {
            const account = singleJson.result.value;
            const dataB64 = extractBase64(account.data);
            if (dataB64) {
              infos[i] = {
                pubkey: pubkeys[i],
                data: dataB64,
                owner: account.owner,
                lamports: account.lamports,
                executable: account.executable,
                rentEpoch: account.rentEpoch,
              };
            }
          }
        } catch (err) {
          // Silent fail, will remain null
        }
      })
    );

    // Update null indices
    nullIndices = infos
      .map((info: AccountInfo | null, i: number) => (info ? -1 : i))
      .filter((i: number) => i >= 0);
  }

  return infos;
}

/**
 * Filter account keys to only those owned by our program
 *
 * @param accountInfos - Array of fetched account info
 * @param programId - Program ID to filter by
 * @returns Filtered array of accounts owned by the program (excludes executable program accounts)
 */
export function filterProgramAccounts(
  accountInfos: (AccountInfo | null)[],
  programId: string
): AccountInfo[] {
  return accountInfos.filter(
    (info): info is AccountInfo =>
      info !== null &&
      info.owner === programId &&
      !info.executable && // Skip the program's executable account
      info.data.length > 0 // Must have data to decode
  );
}
