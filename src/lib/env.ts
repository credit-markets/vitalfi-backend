/**
 * Environment Configuration
 *
 * Validates and exports all environment variables.
 * Throws on missing required variables.
 */

function getEnv(key: string, required = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || "";
}

export const cfg = {
  // Redis
  redisUrl: getEnv("REDIS_URL"),

  // Helius
  heliusSecret: getEnv("HELIUS_WEBHOOK_SECRET"),
  heliusApiKey: getEnv("HELIUS_API_KEY"),

  // Solana
  programId: getEnv("VITALFI_PROGRAM_ID"),
  rpc: getEnv("NEXT_PUBLIC_SOLANA_RPC_ENDPOINT", false) || "https://api.mainnet-beta.solana.com",

  // Cache
  cacheTtl: parseInt(getEnv("CACHE_TTL", false) || "30", 10),

  // Storage
  prefix: getEnv("STORAGE_PREFIX", false) || "vitalfi:",
  activityTtlDays: parseInt(getEnv("ACTIVITY_TTL_DAYS", false) || "30", 10),
};
