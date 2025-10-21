# VitalFi Backend Routes & Integration Spec (KV-only, Helius-driven)

**Version**: 1.0
**Date**: October 21, 2025
**Status**: Authoritative Specification

---

## 1. Scope & Non-Goals

### What This Service Does

- **Event-driven indexing**: Receives Helius webhooks for VitalFi program account changes
- **Normalized caching**: Stores decoded vault/position data as compact DTOs in Redis (Vercel KV)
- **Query APIs**: Provides fast read endpoints for vaults, positions, and activity feeds
- **Edge optimization**: ETag/304 responses with stale-while-revalidate for <50ms latency

### What This Service Does NOT Do

- ❌ **Transaction submission**: Frontend submits transactions directly to RPC
- ❌ **Wallet management**: No private keys, no signing
- ❌ **Analytics/aggregation**: No TVL rollups, no historical snapshots (future phase)
- ❌ **Multi-program indexing**: Only VitalFi Vault program (`146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj`)
- ❌ **Real-time WebSockets**: HTTP-only, poll via React Query refetches

---

## 2. Data Flow

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Solana Blockchain                        │
│         VitalFi Program: 146hbPFqGb9a3v3t1BtkmftNeSNq...    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ Account change events (confirmed/finalized)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Helius Enhanced API                         │
│          (Account-level webhooks, base64 encoding)           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ POST /api/webhooks/helius?token=SECRET
                     │ Headers: X-Helius-Signature (HMAC SHA256)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│             Vercel Serverless Function (Node.js 22)          │
│                                                              │
│  1. Verify HMAC signature (timing-safe)                     │
│  2. Verify token query param                                │
│  3. Decode accounts with Anchor BorshCoder                  │
│  4. Normalize to DTOs (u64→string, enums→string)            │
│  5. Parse logs for instruction types (deltas-over-logs)     │
│  6. Pipeline writes to KV (batch operations)                │
│  7. Update indexes (SETs, ZSETs with slot/epoch scores)     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Vercel KV (Upstash Redis)                      │
│                                                              │
│  Data Blobs:  vault:{pda}:json, position:{pda}:json         │
│               activity:{sig}:{type}:{slot}                  │
│                                                              │
│  Membership:  authority:{pk}:vaults (SET)                   │
│               owner:{pk}:positions (SET)                    │
│                                                              │
│  Ordering:    authority:{pk}:vaults:by_updated (ZSET)       │
│               owner:{pk}:positions:by_updated (ZSET)        │
│               vault:{pda}:activity (ZSET by epoch)          │
│               owner:{pk}:activity (ZSET by epoch)           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ GET requests with If-None-Match
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                VitalFi Next.js Frontend                      │
│                                                              │
│  GET /api/vaults?authority=...&status=...&cursor=...&limit  │
│  GET /api/positions?owner=...&cursor=...&limit              │
│  GET /api/activity?(vault|owner)&cursor=...&limit           │
│                                                              │
│  Headers: If-None-Match: "etag-sha1-hash"                   │
│  Response: ETag, Cache-Control: s-maxage=30, swr=60         │
└─────────────────────────────────────────────────────────────┘
```

### Event Processing Principles

1. **Confirmed/finalized only**: Process events with `commitment: "confirmed"` minimum
2. **Deltas drive amounts**: Use account state deltas (`totalDeposited`, `deposited`) over log parsing for amounts
3. **Logs for instruction types**: Parse log messages for instruction names (deposit, claim, finalize, etc.)
4. **Idempotent writes**: Vaults/Positions use `SET` (last write wins), Activities use `SETNX` (dedup by composite key)
5. **Retry-safe**: Helius retries are handled via idempotency (same payload = same KV state)
6. **Slot/epoch for ordering**: Use `slot` (number) for ZSET scores; `updatedAtEpoch` (Unix seconds) for cursors

---

## 3. KV Keyspace & Indexes

All keys prefixed with `cfg.prefix` (default: `vitalfi:`, configurable via `STORAGE_PREFIX`).

### Data Blobs (JSON)

| Key Pattern | Type | Value | TTL |
|-------------|------|-------|-----|
| `vault:{pda}:json` | STRING | `VaultDTO` | None |
| `position:{pda}:json` | STRING | `PositionDTO` | None |
| `activity:{sig}:{type}:{slot}` | STRING | `ActivityDTO` | 30 days (optional) |

### Membership Indexes (SETs)

| Key Pattern | Type | Members | Purpose |
|-------------|------|---------|---------|
| `vaults:set` | SET | All vault PDAs | Global registry |
| `authority:{pk}:vaults` | SET | Vault PDAs | Query by authority |
| `owner:{pk}:positions` | SET | Position PDAs | Query by owner |

### Ordering Indexes (ZSETs)

| Key Pattern | Score | Members | Purpose |
|-------------|-------|---------|---------|
| `authority:{pk}:vaults:by_updated` | `slot` (number) | Vault PDAs | Sort vaults by update recency |
| `owner:{pk}:positions:by_updated` | `slot` (number) | Position PDAs | Sort positions by update recency |
| `vault:{pda}:activity` | `blockTime epoch` (number) | Activity IDs | Vault activity timeline |
| `owner:{pk}:activity` | `blockTime epoch` (number) | Activity IDs | User activity timeline |

### Authority Change Handling

**Problem**: If a vault's authority changes (via program upgrade logic), the old index becomes stale.

**Solution** (future enhancement):
1. On vault update, check if `vault.authority` differs from previous cached version
2. If changed:
   - `SREM authority:{old_authority}:vaults {vaultPda}`
   - `SADD authority:{new_authority}:vaults {vaultPda}`
   - `ZREM authority:{old_authority}:vaults:by_updated {vaultPda}`
   - `ZADD authority:{new_authority}:vaults:by_updated {slot} {vaultPda}`

**Current status**: Not implemented (authority changes not supported by VitalFi program v1).

### Optional TTL Policy

**Activity events** can expire after 30 days to prevent unbounded growth:

```typescript
await setJSON(kActivity(sig, type, slot), activityDTO, { ex: 30 * 24 * 3600 });
```

**Trade-off**: Loses historical activity beyond 30 days. Consider archiving to S3/R2 before expiry.

---

## 4. DTOs (Stable Contracts)

All DTOs use **strings** for u64/u128 values to avoid JavaScript precision loss (`Number.MAX_SAFE_INTEGER = 2^53 - 1 < u64.MAX`).

### VaultDTO

```typescript
{
  vaultPda: string;           // Base58 PublicKey
  authority: string;          // Base58 PublicKey
  vaultId: string;            // u64 as string
  assetMint: string | null;   // Base58 or null
  status: "Funding" | "Active" | "Matured" | "Canceled";
  cap: string | null;         // u64 lamports as string
  totalDeposited: string | null;
  fundingEndTs: string | null;     // Unix timestamp (i64) as string
  maturityTs: string | null;
  slot: number | null;        // Solana slot (safe as number)
  updatedAt: string;          // ISO 8601 timestamp
  updatedAtEpoch: number;     // Unix epoch seconds (for ZSET scores)
}
```

**Notes**:
- `status` enum mapping: `{ funding: 0 } → "Funding"`, `{ active: 1 } → "Active"`, `{ matured: 2 } → "Matured"`, `{ canceled: 3 } → "Canceled"`
- `slot` stored as number (safe: max Solana slot ~200M/year * 10 years < 2^53)
- `updatedAtEpoch` added for numeric cursor pagination (ZSET score compatibility)

### PositionDTO

```typescript
{
  positionPda: string;
  vaultPda: string;
  owner: string;              // Base58 PublicKey
  deposited: string | null;   // u64 lamports as string
  claimed: string | null;
  slot: number | null;
  updatedAt: string;
  updatedAtEpoch: number;
}
```

### ActivityDTO

```typescript
{
  id: string;                 // `${txSig}:${type}:${slot}` (composite key for idempotency)
  txSig: string;              // Base58 transaction signature
  slot: number;               // Solana slot
  blockTime: string | null;   // ISO 8601 or null (if blockTime unavailable)
  blockTimeEpoch: number | null; // Unix epoch seconds (for ZSET score)
  type: "deposit" | "claim" | "funding_finalized" | "authority_withdraw" | "matured" | "canceled" | "vault_created" | "position_created";
  vaultPda: string | null;
  positionPda: string | null;
  authority: string | null;
  owner: string | null;
  amount: string | null;      // u64 lamports as string (delta from account state, not logs)
  assetMint: string | null;
}
```

**Instruction Type Detection** (log parsing patterns):

```typescript
const LOG_PATTERNS = {
  deposit: /Instruction: Deposit/i,
  claim: /Instruction: Claim/i,
  funding_finalized: /Instruction: FinalizeFunding/i,
  authority_withdraw: /(AuthorityWithdraw|WithdrawFunds)/i,
  matured: /Instruction: MatureVault/i,
  canceled: /(VaultCanceled|FundingCanceled)/i,
  vault_created: /Instruction: InitializeVault/i,
  position_created: /(PositionCreated|InitializePosition)/i,
};
```

---

## 5. Webhook Contract

### POST /api/webhooks/helius?token={secret}

**Purpose**: Ingest account update events from Helius, decode, normalize, and index.

#### Authentication

**Dual-layer security**:

1. **HMAC Signature** (header):
   ```
   X-Helius-Signature: sha256-hex-of-raw-body
   ```
   - Computed: `HMAC-SHA256(raw_body, HELIUS_WEBHOOK_SECRET)`
   - Verified with `crypto.timingSafeEqual()` (constant-time comparison)

2. **Token Parameter** (query):
   ```
   ?token={HELIUS_WEBHOOK_SECRET}
   ```
   - Must match `process.env.HELIUS_WEBHOOK_SECRET` exactly

**Why both?**
- HMAC proves request authenticity (cryptographic)
- Token prevents accidental public exposure (URL-level gate)

#### Request Payload (Helius format)

```json
{
  "accountData": [
    {
      "account": "VaultPDA...",
      "data": "base64EncodedBorshAccountData",
      "owner": "146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj"
    }
  ],
  "meta": {
    "logMessages": [
      "Program log: Instruction: Deposit",
      "Program log: amount: 1000000000"
    ]
  },
  "signature": "5j7s...",
  "slot": 123456789,
  "blockTime": 1697812345
}
```

#### Processing Logic

```typescript
// 1. Verify HMAC
const signature = req.headers['x-helius-signature'];
if (!verifyHeliusSignature(signature, rawBody, cfg.heliusSecret)) {
  return error(res, 401, "Invalid HMAC signature");
}

// 2. Verify token
if (req.query.token !== cfg.heliusSecret) {
  return error(res, 401, "Invalid token");
}

// 3. Decode accounts
for (const { account, data, owner } of payload.accountData) {
  if (owner !== VITALFI_PROGRAM_ID) continue;

  const decoded = decodeAccount(data); // Tries Vault, then Position schemas
  if (!decoded) continue;

  if (decoded.type === 'vault') {
    const dto = toVaultDTO(decoded, account, payload.slot, payload.blockTime);
    await writeVaultToKV(dto); // SET vault:json, SADD indexes, ZADD by slot
  } else if (decoded.type === 'position') {
    const dto = toPositionDTO(decoded, account, payload.slot, payload.blockTime);
    await writePositionToKV(dto);
  }
}

// 4. Parse logs for activities
const activities = extractActionsFromLogs(payload.meta.logMessages, payload);
for (const activity of activities) {
  const key = kActivity(activity.txSig, activity.type, activity.slot);
  const created = await setnx(key, JSON.stringify(activity)); // Idempotent (returns 0 if exists)
  if (created) {
    // Add to activity ZSETs (scored by blockTimeEpoch)
    if (activity.vaultPda) {
      await zadd(kVaultActivity(activity.vaultPda), activity.blockTimeEpoch, key);
    }
    if (activity.owner) {
      await zadd(kOwnerActivity(activity.owner), activity.blockTimeEpoch, key);
    }
  }
}
```

#### Deltas Over Logs

**Amount extraction priority**:

1. **Account state deltas** (preferred):
   - Vault: `dto.totalDeposited` (current snapshot)
   - Position: `dto.deposited` (current snapshot)

2. **Log parsing** (fallback if account not in payload):
   ```typescript
   const amountMatch = log.match(/amount[:\s]+(\d+)/i);
   activity.amount = amountMatch ? amountMatch[1] : null;
   ```

**Rationale**: Account state is source of truth; logs can be truncated/missing.

#### KV Pipeline (Batch Writes)

**Use Redis pipelining** to minimize round-trips:

```typescript
const pipeline = [
  setJSON(kVaultJson(pda), vaultDTO),
  sadd(kVaultsSet(), pda),
  sadd(kAuthorityVaults(vaultDTO.authority), pda),
  zadd(kAuthorityVaultsByUpdated(vaultDTO.authority), vaultDTO.slot, pda),
];

await Promise.all(pipeline); // Parallel execution
```

#### Finality Requirement

**Only process confirmed/finalized events**:

- Helius webhook configuration: Set commitment to `confirmed` minimum
- Ignore `processed` commitment events (can be rolled back)

**Slot tracking** (optional future enhancement):

```typescript
const lastProcessedSlot = await getJSON<number>('last_processed_slot');
if (payload.slot <= lastProcessedSlot) {
  return; // Skip duplicate/reorg
}
await setJSON('last_processed_slot', payload.slot);
```

#### Max Content Length

Limit webhook payload size to prevent DoS:

```typescript
// vercel.json
{
  "functions": {
    "api/webhooks/helius.ts": {
      "maxDuration": 10,
      "memory": 512
    }
  }
}
```

**Vercel default**: 5MB body size limit (sufficient for account data).

#### Response

```json
{
  "ok": true,
  "processed": {
    "vaults": 1,
    "positions": 2,
    "activities": 3
  }
}
```

**Status codes**:
- `200`: Successfully processed
- `401`: Invalid HMAC or token
- `400`: Malformed payload
- `500`: Internal error (KV failure, decoding error)

---

## 6. Read Endpoints

All read endpoints share:

- ✅ **ETag support**: `If-None-Match` → 304 Not Modified
- ✅ **Cache headers**: `Cache-Control: s-maxage=30, stale-while-revalidate=60`
- ✅ **Zod validation**: Strict query param schemas
- ✅ **Numeric cursors**: Epoch seconds (not ISO strings)
- ✅ **Error format**: `{ error: string, details?: any }`

---

### 6.1 GET /api/vaults?authority&status&cursor&limit

**Purpose**: List vaults by authority with optional status filtering and cursor pagination.

#### Query Schema (Zod)

```typescript
const QuerySchema = z.object({
  authority: z.string().length(44),  // Base58 pubkey (exact length)
  status: z.enum(["Funding", "Active", "Matured", "Canceled"]).optional(),
  cursor: z.coerce.number().int().positive().optional(), // Unix epoch OR slot
  limit: z.coerce.number().min(1).max(100).default(50),
});
```

#### Behavior

1. **ZSET-first** (if `cursor` provided OR ZSET exists):
   ```typescript
   const maxScore = cursor ?? Number.POSITIVE_INFINITY;
   const pdas = await zrevrangebyscore(
     kAuthorityVaultsByUpdated(authority),
     maxScore,
     0,
     { offset: 0, count: limit + 1 }
   );
   ```

2. **SET fallback** (if ZSET empty):
   ```typescript
   const pdas = await smembers(kAuthorityVaults(authority));
   ```

3. **Batch fetch vaults**:
   ```typescript
   const vaults = await Promise.all(
     pdas.map(pda => getJSON<VaultDTO>(kVaultJson(pda)))
   );
   ```

4. **Filter by status** (in-memory):
   ```typescript
   const filtered = status ? vaults.filter(v => v.status === status) : vaults;
   ```

5. **Sort by slot DESC** (most recent first):
   ```typescript
   filtered.sort((a, b) => (b.slot || 0) - (a.slot || 0));
   ```

6. **Paginate**:
   ```typescript
   const hasMore = filtered.length > limit;
   const items = filtered.slice(0, limit);
   const nextCursor = hasMore ? items[items.length - 1].updatedAtEpoch : null;
   ```

#### Response

```json
{
  "items": [
    {
      "vaultPda": "...",
      "authority": "...",
      "vaultId": "1",
      "status": "Funding",
      "cap": "100000000000",
      "totalDeposited": "50000000000",
      "slot": 123456789,
      "updatedAt": "2025-10-21T12:00:00.000Z",
      "updatedAtEpoch": 1697900000
    }
  ],
  "nextCursor": 1697900000,
  "total": 10
}
```

#### KV Keys Used

- `authority:{authority}:vaults:by_updated` (ZSET)
- `authority:{authority}:vaults` (SET fallback)
- `vault:{pda}:json` (per vault)

#### Caching

- **Headers**: `ETag: "sha1-16chars"`, `Cache-Control: s-maxage=30, stale-while-revalidate=60`
- **304 flow**: Client sends `If-None-Match: "previous-etag"` → Server responds `304` with same headers

---

### 6.2 GET /api/positions?owner&cursor&limit

**Purpose**: List positions for a user with cursor pagination.

#### Query Schema

```typescript
const QuerySchema = z.object({
  owner: z.string().length(44),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});
```

#### Behavior

Identical to `/api/vaults` but uses:

- **ZSET**: `owner:{owner}:positions:by_updated` (score: `slot`)
- **SET fallback**: `owner:{owner}:positions`
- **Data**: `position:{pda}:json`

#### Response

```json
{
  "items": [
    {
      "positionPda": "...",
      "vaultPda": "...",
      "owner": "...",
      "deposited": "10000000000",
      "claimed": "0",
      "slot": 123456789,
      "updatedAt": "2025-10-21T12:00:00.000Z",
      "updatedAtEpoch": 1697900000
    }
  ],
  "nextCursor": 1697899900,
  "total": 5
}
```

---

### 6.3 GET /api/activity?(vault|owner)&cursor&limit&type

**Purpose**: Paginated activity feed for a vault OR owner (exactly one required).

#### Query Schema

```typescript
const QuerySchema = z.object({
  vault: z.string().length(44).optional(),
  owner: z.string().length(44).optional(),
  cursor: z.coerce.number().int().positive().optional(), // blockTimeEpoch
  limit: z.coerce.number().min(1).max(100).default(50),
  type: z.enum([
    "deposit", "claim", "funding_finalized", "authority_withdraw",
    "matured", "canceled", "vault_created", "position_created"
  ]).optional(),
}).refine(data => data.vault || data.owner, {
  message: "Exactly one of 'vault' or 'owner' required",
});
```

#### Behavior

1. **Choose ZSET**:
   ```typescript
   const zsetKey = vault ? kVaultActivity(vault) : kOwnerActivity(owner!);
   ```

2. **Query with cursor** (reverse chronological):
   ```typescript
   const maxScore = cursor ?? Number.POSITIVE_INFINITY;
   const activityIds = await zrevrangebyscore(
     zsetKey,
     maxScore,
     0,
     { offset: 0, count: limit + 1 }
   );
   ```

3. **Fetch activity JSONs**:
   ```typescript
   const activities = await Promise.all(
     activityIds.slice(0, limit).map(id => getJSON<ActivityDTO>(id))
   );
   ```

4. **Client-side type filter** (if provided):
   - Backend returns all types; client filters locally (avoids multiple ZSET queries)
   - **Alternative**: Add per-type ZSETs (`vault:{pda}:activity:deposit`) if filtering is critical

5. **Compute next cursor**:
   ```typescript
   const hasMore = activityIds.length > limit;
   const nextCursor = hasMore ? activities[activities.length - 1].blockTimeEpoch : null;
   ```

#### Response

```json
{
  "items": [
    {
      "id": "5j7s...:deposit:123456789",
      "txSig": "5j7s...",
      "slot": 123456789,
      "blockTime": "2025-10-21T12:00:00.000Z",
      "blockTimeEpoch": 1697900000,
      "type": "deposit",
      "vaultPda": "...",
      "owner": "...",
      "amount": "1000000000"
    }
  ],
  "nextCursor": 1697899900,
  "total": null
}
```

**Note**: `total` is `null` for activity feeds (ZSET cardinality requires `ZCARD`, not included to save latency).

#### KV Keys Used

- `vault:{pda}:activity` OR `owner:{pk}:activity` (ZSET)
- `activity:{sig}:{type}:{slot}` (per activity)

---

## 7. Frontend Integration

### React Query Hook Examples

#### useVaultsAPI

```typescript
import { useQuery } from "@tanstack/react-query";

export function useVaultsAPI(params: {
  authority: string;
  status?: "Funding" | "Active" | "Matured" | "Canceled";
  cursor?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ["vaults-api", params],
    queryFn: async () => {
      const url = new URL("/api/vaults", process.env.NEXT_PUBLIC_VITALFI_API_URL);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) url.searchParams.set(k, String(v));
      });

      const cachedEtag = getEtagFromCache(queryKey);
      const headers: HeadersInit = {};
      if (cachedEtag) {
        headers["If-None-Match"] = cachedEtag;
      }

      const res = await fetch(url, { headers });
      if (res.status === 304) {
        return getCachedData(queryKey); // Return stale data
      }

      const etag = res.headers.get("ETag");
      const data = await res.json();

      if (etag) {
        cacheEtag(queryKey, etag);
        cacheData(queryKey, data);
      }

      return data;
    },
    staleTime: 30_000, // Match backend s-maxage
    refetchOnWindowFocus: false,
    retry: 3,
  });
}
```

#### useInfiniteActivity (Infinite Scroll)

```typescript
import { useInfiniteQuery } from "@tanstack/react-query";

export function useInfiniteActivity(params: { vault?: string; owner?: string }) {
  return useInfiniteQuery({
    queryKey: ["activity-api", params],
    queryFn: async ({ pageParam = undefined }) => {
      const url = new URL("/api/activity", process.env.NEXT_PUBLIC_VITALFI_API_URL);
      if (params.vault) url.searchParams.set("vault", params.vault);
      if (params.owner) url.searchParams.set("owner", params.owner);
      if (pageParam) url.searchParams.set("cursor", String(pageParam));

      const res = await fetch(url);
      return res.json();
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 15_000,
  });
}
```

### ETag + 304 Handling

**Client-side ETag cache** (React Query `placeholderData` + localStorage):

```typescript
const ETAG_CACHE_KEY = "vitalfi:etags";

function getEtagFromCache(queryKey: unknown[]): string | null {
  const cache = JSON.parse(localStorage.getItem(ETAG_CACHE_KEY) || "{}");
  return cache[JSON.stringify(queryKey)] || null;
}

function cacheEtag(queryKey: unknown[], etag: string) {
  const cache = JSON.parse(localStorage.getItem(ETAG_CACHE_KEY) || "{}");
  cache[JSON.stringify(queryKey)] = etag;
  localStorage.setItem(ETAG_CACHE_KEY, JSON.stringify(cache));
}
```

### Feature Flag Strategy

**Environment variable** (`.env.local`):

```env
NEXT_PUBLIC_USE_BACKEND_API=true
```

**Conditional hook usage**:

```typescript
export function useFundingVault() {
  const useBackend = process.env.NEXT_PUBLIC_USE_BACKEND_API === "true";

  if (useBackend) {
    return useFundingVaultAPI(); // Calls backend /api/vaults
  } else {
    return useFundingVaultRPC(); // Direct RPC (existing)
  }
}
```

**Rollout strategy**:

1. Deploy backend, verify data accuracy
2. Enable flag for 10% users (Vercel Edge Config)
3. Monitor error rates, compare data consistency
4. Increase to 50%, then 100%
5. Remove RPC fallback after 2 weeks stable

### When to Use Backend vs. RPC

| Operation | Backend | RPC | Rationale |
|-----------|---------|-----|-----------|
| **List vaults by authority** | ✅ | ❌ | Indexed queries, pagination |
| **List user positions** | ✅ | ❌ | Indexed queries |
| **Activity feeds** | ✅ | ❌ | ZSET pagination, no RPC getSignaturesForAddress needed |
| **Single vault by PDA** | ⚠️ Optional | ✅ | RPC for instant correctness; backend for edge caching |
| **Single position by PDA** | ⚠️ Optional | ✅ | Same as vault |
| **Submit deposit/claim** | ❌ | ✅ | Writes always go to RPC |

**When backend is safe for single-PDA reads**:

- Latency improves via edge caching (< 50ms vs. 200ms RPC)
- Near-real-time is acceptable (< 30s stale via webhook)
- Code complexity reduces (one API surface)

**When RPC is required**:

- Immediate post-transaction verification (wallet just submitted deposit)
- No backend deployed yet
- Backend returns 5xx (graceful degradation)

---

## 8. Validation & Observability

### Zod Schemas (Exact Shapes)

#### Vaults Query

```typescript
const VaultsQuerySchema = z.object({
  authority: z.string().length(44),
  status: z.enum(["Funding", "Active", "Matured", "Canceled"]).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});
```

#### Positions Query

```typescript
const PositionsQuerySchema = z.object({
  owner: z.string().length(44),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});
```

#### Activity Query

```typescript
const ActivityQuerySchema = z.object({
  vault: z.string().length(44).optional(),
  owner: z.string().length(44).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  type: z.enum([
    "deposit", "claim", "funding_finalized", "authority_withdraw",
    "matured", "canceled", "vault_created", "position_created"
  ]).optional(),
}).refine(data => (data.vault || data.owner) && !(data.vault && data.owner), {
  message: "Exactly one of 'vault' or 'owner' required",
});
```

### ETag Generation

```typescript
import { createHash } from "crypto";

export function createEtag(body: object): string {
  const json = JSON.stringify(body);
  const hash = createHash("sha1").update(json).digest("hex").substring(0, 16);
  return `"${hash}"`;
}
```

### 304 Not Modified Flow

```typescript
const etag = createEtag(responseBody);

if (req.headers["if-none-match"] === etag) {
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", `s-maxage=${cfg.cacheTtl}, stale-while-revalidate=${cfg.cacheTtl * 2}`);
  return res.status(304).end();
}

res.setHeader("ETag", etag);
res.setHeader("Cache-Control", `s-maxage=${cfg.cacheTtl}, stale-while-revalidate=${cfg.cacheTtl * 2}`);
return res.status(200).json(responseBody);
```

### Minimal Tests

**Health endpoint**:

```typescript
import { describe, it, expect } from "vitest";
import handler from "../api/health";

describe("GET /api/health", () => {
  it("returns 200 with ok:true", async () => {
    const req = { method: "GET" };
    const res = mockResponse();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ ok: true, kv: true });
  });
});
```

**HMAC verification**:

```typescript
it("rejects invalid HMAC signature", async () => {
  const body = JSON.stringify({ accountData: [] });
  const req = {
    method: "POST",
    headers: { "x-helius-signature": "invalid" },
    query: { token: "correct-secret" },
    body,
  };
  const res = mockResponse();
  await handler(req, res);
  expect(res._getStatusCode()).toBe(401);
});
```

**DTO shape validation**:

```typescript
it("VaultDTO matches schema", () => {
  const vault: VaultDTO = {
    vaultPda: "VaultPDA...",
    authority: "Authority...",
    vaultId: "1",
    status: "Funding",
    cap: "100000000000",
    totalDeposited: "50000000000",
    slot: 123456789,
    updatedAt: "2025-10-21T12:00:00.000Z",
    updatedAtEpoch: 1697900000,
  };
  expect(VaultDTOSchema.parse(vault)).toEqual(vault);
});
```

**Pagination logic**:

```typescript
it("computes nextCursor correctly", () => {
  const items = [
    { blockTimeEpoch: 1000 },
    { blockTimeEpoch: 900 },
  ];
  const cursor = nextCursorFromLastItem(items[items.length - 1]);
  expect(cursor).toBe(900);
});
```

### Logging Fields and Redactions

**Structured logs** (`src/lib/logger.ts`):

```typescript
logger.info({
  method: "POST",
  path: "/api/webhooks/helius",
  duration: 123,
  status: 200,
  processed: { vaults: 1, positions: 2, activities: 3 },
});
```

**Redacted secrets**:

```typescript
const REDACT_PATTERNS = [
  /HELIUS_WEBHOOK_SECRET/gi,
  /HELIUS_API_KEY/gi,
  /KV_REST_API_TOKEN/gi,
  /REDIS_URL/gi,
];

function redactSecrets(obj: any): any {
  // Recursively redact matching keys/values
  return JSON.parse(
    JSON.stringify(obj).replace(
      new RegExp(REDACT_PATTERNS.map(p => p.source).join("|"), "gi"),
      "***REDACTED***"
    )
  );
}
```

---

## 9. Open Questions & Future Work

### Open Questions

1. **Backfill script**:
   - How to populate KV with existing on-chain state on initial deployment?
   - **Proposed**: One-time script that scans all program accounts via `getProgramAccounts`, decodes, and writes to KV.

2. **TTL/retention for activities**:
   - Should activity events expire after 30/60/90 days?
   - **Proposed**: 30-day TTL with optional archive to S3/R2 before deletion.

3. **Multi-program support**:
   - Extend to index multiple Solana programs (e.g., VitalFi Lending, VitalFi Staking)?
   - **Proposed**: Add `program_id` field to DTOs, create per-program KV namespaces.

4. **Numeric cursor format**:
   - Use `slot` or `updatedAtEpoch` for cursor scores?
   - **Decision**: Use `updatedAtEpoch` (Unix seconds) for consistency with activity feeds.

5. **Authority change handling**:
   - If program adds authority transfer logic, update indexes atomically?
   - **Proposed**: Detect authority delta in webhook, run SREM/SADD/ZREM/ZADD fixups.

### Future Work (Phase 2+)

1. **Enhanced activity parsing**:
   - Extract amounts from instruction data (not just logs)
   - Parse CPI events for cross-program calls
   - Decode memo fields if present

2. **Advanced caching**:
   - Add Redis EXPIRE to activity events (30-day TTL)
   - Implement background cache warming for hot vaults
   - Add Vercel Edge Config for feature flags

3. **Analytics endpoints**:
   - Aggregate stats: total TVL, daily volume, unique users
   - Historical snapshots (daily vault states)
   - `/api/stats` endpoint with rollups

4. **GraphQL API**:
   - Replace REST with GraphQL for flexible queries
   - Use Pothos or TypeGraphQL
   - Single query for vault + positions + activity

5. **Full-text search**:
   - Add Typesense/Algolia for vault name/description search
   - Search by asset mint, originator, etc.

6. **Rate limiting**:
   - Add Upstash Rate Limit for per-IP/per-endpoint limits
   - Example: 60 req/min per IP on `/api/vaults`

7. **Monitoring & alerts**:
   - Sentry integration for error tracking
   - DataDog APM for latency monitoring
   - Alerts: 5% error rate, 100ms p95 latency, 5min downtime

---

## 10. Compliance Checklist

Before production deployment, verify:

- ✅ All DTOs use **strings** for u64/u128 (no precision loss)
- ✅ All cursors are **numeric** (epoch seconds, not ISO strings)
- ✅ Webhook processes **confirmed/finalized** events only
- ✅ HMAC verification uses **timing-safe comparison**
- ✅ All writes are **idempotent** (SET for vaults/positions, SETNX for activities)
- ✅ KV operations use **pipelining** for batch writes
- ✅ Deltas drive amounts (**account state over logs**)
- ✅ All endpoints support **ETag/304**
- ✅ All query params use **strict Zod validation**
- ✅ Logs **redact secrets** automatically
- ✅ Error responses are **uniform JSON** format
- ✅ ZSET scores use **slot or updatedAtEpoch** (numeric)
- ✅ Activity ZSETs use **blockTimeEpoch** for ordering

---

**End of Specification** — This document supersedes all previous planning docs. All implementation must align with these contracts.
