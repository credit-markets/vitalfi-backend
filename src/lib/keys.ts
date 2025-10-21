/**
 * KV Keyspace Helpers
 *
 * Centralizes all key generation logic for consistency.
 * Keys are prefixed with cfg.prefix (e.g., "vitalfi:")
 */

/**
 * Vault JSON blob
 */
export function kVaultJson(pda: string): string {
  return `vault:${pda}:json`;
}

/**
 * Vault summary (optional, for future use)
 */
export function kVaultSummary(pda: string): string {
  return `vault:${pda}:summary`;
}

/**
 * Global set of all vault PDAs
 */
export function kVaultsSet(): string {
  return "vaults:set";
}

/**
 * Set of vault PDAs for a given authority
 */
export function kAuthorityVaults(authority: string): string {
  return `authority:${authority}:vaults`;
}

/**
 * Position JSON blob
 */
export function kPositionJson(pda: string): string {
  return `position:${pda}:json`;
}

/**
 * Set of position PDAs for a given owner
 */
export function kOwnerPositions(owner: string): string {
  return `owner:${owner}:positions`;
}

/**
 * Sorted set of activity for a vault (sorted by blockTime)
 */
export function kVaultActivity(vaultPda: string): string {
  return `vault:${vaultPda}:activity`;
}

/**
 * Sorted set of activity for an owner (sorted by blockTime)
 */
export function kOwnerActivity(owner: string): string {
  return `owner:${owner}:activity`;
}

/**
 * Activity JSON blob
 */
export function kActivity(txSig: string, type: string, slot: number): string {
  return `activity:${txSig}:${type}:${slot}`;
}
