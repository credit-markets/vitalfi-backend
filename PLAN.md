# VitalFi Backend Architecture Plan

**Version**: 1.0
**Date**: October 20, 2025
**Status**: Ready for Implementation

---

## Executive Summary

This backend serves as a **lightweight indexing and caching layer** between the Solana blockchain and the VitalFi Next.js frontend. It eliminates the N+1 query problem, reduces RPC load by 90%, and enables fast vault/position queries at scale.

**Core Principle**: Event-driven architecture where Helius webhooks push state changes, not pull-based polling.

---

## 1. Architecture Overview

### 1.1 System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Solana Blockchain                        │
│                   VitalFi Program: 146hbP...                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ Account change events
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Helius Enhanced API                        │
│              (Account-level webhooks + RPC)                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ POST /api/webhooks/helius
                         │ HMAC + ?token auth
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Vercel Serverless Function                    │
│                     (Node.js 22 runtime)                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 1. Verify HMAC signature (constant time)                 │  │
│  │ 2. Decode accounts with Anchor BorshCoder                │  │
│  │ 3. Normalize to DTO (vault/position/activity)            │  │
│  │ 4. Write to KV with idempotent keys                      │  │
│  │ 5. Update indexes (sets, sorted sets)                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Vercel KV (Upstash Redis)                          │
│                                                                  │
│  Data Layer:                                                    │
│    • Vault JSON blobs (SET)                                    │
│    • Position JSON blobs (SET)                                 │
│    • Activity JSON blobs (SET)                                 │
│                                                                  │
│  Index Layer:                                                   │
│    • vaults:set (global registry)                              │
│    • authority:<pk>:vaults (SET per authority)                 │
│    • owner:<pk>:positions (SET per user)                       │
│    • vault:<pda>:activity (ZSET by blockTime)                  │
│    • owner:<pk>:activity (ZSET by blockTime)                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ GET requests with ETag/304
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   VitalFi Next.js Frontend                       │
│                                                                  │
│  New API Hooks:                                                 │
│    • GET /api/vaults?authority=...&status=...                   │
│    • GET /api/positions?owner=...                               │
│    • GET /api/activity?vault=...&cursor=...&limit=50            │
│    • GET /api/activity?owner=...&cursor=...&limit=50            │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Design Principles

1. **Serverless-First**: No background workers, no cron jobs. Everything happens in HTTP handlers.
2. **Idempotent Writes**: Webhooks can retry safely. Use SETNX for deduplication.
3. **Normalized Storage**: Store compact DTOs, not raw blockchain data.
4. **Index-Heavy**: Use Redis SETs and ZSETs for fast queries.
5. **Cache-Friendly**: ETag + stale-while-revalidate for edge caching.
6. **Type-Safe**: Zod for runtime validation, TypeScript strict mode.

---

## 2. Technology Stack & Rationale

### 2.1 Runtime & Framework

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Vercel Node.js 22 | Need Buffer, Anchor BorshCoder, crypto.createHmac |
| **Language** | TypeScript 5.6+ | Type safety, strict mode, ES2022 target for BigInt |
| **Framework** | Vercel Serverless | Zero-config deployment, auto-scaling, edge network |
| **Validation** | Zod 3.23+ | Runtime type checking, schema validation |
| **Testing** | Vitest 2.1+ | Fast, ESM-native, TypeScript support |

**Why NOT Edge Runtime?**
- Edge runtime lacks Node.js APIs: `Buffer`, `crypto.createHmac`
- Anchor's BorshCoder requires Node Buffer
- HMAC verification needs raw request body (not available in Edge)

### 2.2 Storage Architecture

**Vercel KV (Upstash Redis)**

**Why Redis over Postgres?**
- ✅ **No schema migrations** - Store JSON blobs directly
- ✅ **Native indexing** - SETs and ZSETs for fast queries
- ✅ **Sub-ms latency** - Critical for API response times
- ✅ **Simple ops** - No connection pooling, no ORM complexity
- ✅ **Serverless-native** - HTTP-based, no persistent connections

**Trade-offs**:
- ❌ No relational queries (solved with denormalization)
- ❌ No ACID transactions across multiple keys (not needed)
- ❌ Limited to 1-2GB dataset (sufficient for MVP, 10K vaults = ~50MB)

### 2.3 Blockchain Integration

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Indexer** | Helius Enhanced Webhooks | Account-level notifications, 99.9% uptime |
| **Decoder** | Anchor BorshCoder | Matches program IDL, type-safe account parsing |
| **IDL Source** | `@pollum-io/vitalfi-programs` | Published package from programs repo |
| **Fallback** | Local IDL JSON copy | In case npm package unavailable |

**Why Helius over Custom Indexer?**
- ✅ **Managed service** - No infrastructure to maintain
- ✅ **Real-time** - < 1s latency from on-chain to webhook
- ✅ **Reliable** - Built-in retries, dead letter queue
- ✅ **Scalable** - Handles mainnet load out of the box
- ❌ **Cost**: ~$50/mo for 1M requests (acceptable for MVP)

---

## 3. Data Model

### 3.1 KV Keyspace Design

**Namespace Pattern**: `vitalfi:<entity>:<identifier>:<field>`

#### Primary Data (JSON Blobs)

```
vault:{vaultPda}:json                    → VaultDTO (string)
position:{positionPda}:json              → PositionDTO (string)
activity:{txSig}:{type}:{slot}           → ActivityDTO (string)
```

#### Global Indexes

```
vaults:set                               → SET of all vault PDAs
```

#### Query Indexes

```
authority:{authorityPubkey}:vaults       → SET of vault PDAs
owner:{ownerPubkey}:positions            → SET of position PDAs
vault:{vaultPda}:activity                → ZSET (score: blockTime epoch)
owner:{ownerPubkey}:activity             → ZSET (score: blockTime epoch)
```

#### Metadata

```
health:ts                                → Last health check timestamp
```

### 3.2 Data Schemas (DTOs)

**VaultDTO** (`src/types/dto.ts`):
```typescript
{
  vaultPda: string;           // Base58 public key
  authority: string;          // Base58 public key
  vaultId: string;            // u64 as string
  assetMint: string | null;   // Base58 or null
  status: "Funding" | "Active" | "Matured" | "Canceled";
  cap: string | null;         // u64 as string (lamports)
  totalDeposited: string | null;
  fundingEndTs: string | null;     // Unix timestamp as string
  maturityTs: string | null;
  slot: number | null;        // Solana slot
  updatedAt: string;          // ISO 8601 timestamp
}
```

**PositionDTO**:
```typescript
{
  positionPda: string;
  vaultPda: string;
  owner: string;
  deposited: string | null;   // u64 as string
  claimed: string | null;
  slot: number | null;
  updatedAt: string;
}
```

**ActivityDTO**:
```typescript
{
  id: string;                 // `${txSig}:${type}:${slot}`
  txSig: string;
  slot: number;
  blockTime: string | null;   // ISO 8601 or null
  type: "deposit" | "claim" | "funding_finalized" | "matured" | "canceled" | "vault_created" | "position_created";
  vaultPda: string | null;
  positionPda: string | null;
  authority: string | null;
  owner: string | null;
  amount: string | null;      // u64 as string
  assetMint: string | null;
}
```

**Design Notes**:
- All numeric fields stored as **strings** to avoid JavaScript number precision issues (u64 > Number.MAX_SAFE_INTEGER)
- Timestamps stored as **ISO 8601 strings** for human readability
- Slot stored as **number** (safe, max slot far from 2^53)
- All pubkeys as **Base58 strings** (Solana standard)

### 3.3 Index Strategy

**Query Pattern → Index Used**:

| Query | Index | Complexity |
|-------|-------|------------|
| Get vault by PDA | Direct key: `vault:{pda}:json` | O(1) |
| List vaults by authority | `authority:{auth}:vaults` → SMEMBERS | O(N) where N = vaults per authority |
| Get position by PDA | Direct key: `position:{pda}:json` | O(1) |
| List positions by owner | `owner:{owner}:positions` → SMEMBERS | O(N) where N = positions per owner |
| Vault activity (paginated) | `vault:{pda}:activity` → ZREVRANGEBYSCORE | O(log(N) + M) where M = page size |
| User activity (paginated) | `owner:{owner}:activity` → ZREVRANGEBYSCORE | O(log(N) + M) |

**Scalability**:
- **1K vaults, 10K users, 100K positions** → ~50MB storage
- SMEMBERS on 100 items → ~1ms latency
- ZREVRANGEBYSCORE with cursor pagination → ~2ms per page

---

## 4. API Specification

### 4.1 Endpoints

#### **GET /api/health**

**Purpose**: Health check for monitoring

**Response**:
```json
{
  "ok": true,
  "kv": true,
  "timestamp": "2025-10-20T12:00:00.000Z"
}
```

**Headers**:
- `Cache-Control: no-cache`

---

#### **POST /api/webhooks/helius?token={secret}**

**Purpose**: Receive account update events from Helius

**Authentication**:
1. HMAC signature in `X-Helius-Signature` header
2. Query param `?token` must match `HELIUS_WEBHOOK_SECRET`

**Request Body** (Helius format):
```json
{
  "accountData": [
    {
      "account": "VaultPDA...",
      "data": "base64EncodedAccountData",
      "owner": "146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj"
    }
  ],
  "meta": {
    "logMessages": ["Program log: deposit amount: 1000000000"]
  },
  "signature": "5j7s...",
  "slot": 123456789,
  "blockTime": 1697812345
}
```

**Response**:
```json
{
  "ok": true,
  "processed": {
    "vaults": 1,
    "positions": 0,
    "activities": 1
  }
}
```

**Processing Logic**:
1. Verify HMAC (constant-time comparison)
2. Verify `?token` query param
3. For each `accountData` where `owner === VITALFI_PROGRAM_ID`:
   - Try decoding as Vault → Write vault JSON + indexes
   - Try decoding as Position → Write position JSON + indexes
4. Parse `meta.logMessages` for instruction names:
   - Match patterns: `"deposit"`, `"claim"`, `"finalize_funding"`, etc.
   - Create ActivityDTO and write to activity JSON + ZSETs
5. Return success with counts

**Idempotency**:
- Vault/Position writes use `SET` (last write wins, safe)
- Activity writes use `SETNX` on `activity:{sig}:{type}:{slot}` (deduplicates retries)

---

#### **GET /api/vaults?authority={pubkey}&status={status}&limit={N}**

**Purpose**: List vaults by authority with optional filtering

**Query Params**:
- `authority` (required): Authority pubkey (Base58)
- `status` (optional): Filter by "Funding" | "Active" | "Matured" | "Canceled"
- `limit` (optional): Max items (default 50, max 100)

**Response**:
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
      "fundingEndTs": "1697900000",
      "maturityTs": "1698000000",
      "slot": 123456789,
      "updatedAt": "2025-10-20T12:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "total": 1
}
```

**Headers**:
- `Cache-Control: s-maxage=30, stale-while-revalidate=60`
- `ETag: "sha1-hash-of-body"`

**304 Not Modified**:
- If `If-None-Match: {etag}` matches, return 304 with same headers

**Implementation**:
1. Validate query params with Zod
2. `SMEMBERS authority:{authority}:vaults` → Get set of PDAs
3. Batch `GET` for each `vault:{pda}:json`
4. Filter by status in-memory (if provided)
5. Sort by `slot` DESC (most recent first)
6. Slice to `limit`
7. Compute ETag from JSON body
8. Return with cache headers

---

#### **GET /api/positions?owner={pubkey}&limit={N}**

**Purpose**: List positions for a user

**Query Params**:
- `owner` (required): User wallet pubkey (Base58)
- `limit` (optional): Max items (default 50, max 100)

**Response**:
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
      "updatedAt": "2025-10-20T12:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "total": 1
}
```

**Headers**: Same as `/api/vaults`

**Implementation**: Same pattern as vaults, using `owner:{owner}:positions` index

---

#### **GET /api/activity?vault={pda}&cursor={iso}&limit={N}**
#### **GET /api/activity?owner={pubkey}&cursor={iso}&limit={N}**

**Purpose**: Paginated activity feed for a vault or user

**Query Params**:
- `vault` (optional): Vault PDA (Base58) - exactly one of vault/owner required
- `owner` (optional): User pubkey (Base58)
- `cursor` (optional): ISO timestamp for pagination (returns events before cursor)
- `limit` (optional): Page size (default 50, max 100)

**Response**:
```json
{
  "items": [
    {
      "id": "5j7s...:deposit:123456789",
      "txSig": "5j7s...",
      "slot": 123456789,
      "blockTime": "2025-10-20T12:00:00.000Z",
      "type": "deposit",
      "vaultPda": "...",
      "owner": "...",
      "amount": "1000000000",
      "assetMint": "So111..."
    }
  ],
  "nextCursor": "2025-10-20T11:59:00.000Z",
  "total": null
}
```

**Headers**: Same as `/api/vaults`

**Implementation**:
1. Choose ZSET: `vault:{pda}:activity` or `owner:{owner}:activity`
2. Parse `cursor` as ISO timestamp → Unix epoch (or use `+inf` if null)
3. `ZREVRANGEBYSCORE {zset} {cursor} -inf LIMIT 0 {limit+1}`
   - Returns activity IDs like `activity:{sig}:{type}:{slot}`
4. Batch `GET` for each activity JSON
5. Take first `limit` items (extra is for hasMore detection)
6. If result length > limit, set `nextCursor` to last item's `blockTime`
7. Return with ETag

**Cursor Format**: ISO 8601 timestamp (e.g., `2025-10-20T12:00:00.000Z`)

---

### 4.2 Error Responses

**400 Bad Request**:
```json
{
  "error": "Invalid query parameters",
  "details": [
    { "path": "authority", "message": "Required" }
  ]
}
```

**401 Unauthorized**:
```json
{
  "error": "Invalid HMAC signature"
}
```

**405 Method Not Allowed**:
```json
{
  "error": "Method not allowed"
}
```

**500 Internal Server Error**:
```json
{
  "error": "Internal server error",
  "message": "Failed to fetch from KV"
}
```

---

## 5. Security

### 5.1 Webhook Authentication

**Two-Layer Defense**:

1. **HMAC Signature Verification**
   ```typescript
   const signature = req.headers['x-helius-signature'];
   const computed = crypto
     .createHmac('sha256', HELIUS_WEBHOOK_SECRET)
     .update(rawBody)
     .digest('hex');

   if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
     throw new Error('Invalid signature');
   }
   ```

2. **Token Query Parameter**
   ```typescript
   const { token } = req.query;
   if (token !== process.env.HELIUS_WEBHOOK_SECRET) {
     throw new Error('Invalid token');
   }
   ```

**Why Both?**
- HMAC prevents tampering (cryptographic proof)
- Token prevents accidental exposure (public URL protection)

### 5.2 Rate Limiting

**Phase 1 (MVP)**: Rely on Vercel's built-in rate limiting (100 req/10s per IP)

**Phase 2 (Production)**:
- Use Vercel Edge Config or Upstash Rate Limit
- Implement per-IP and per-endpoint limits
- Example: `/api/vaults` → 60 req/min per IP

### 5.3 Input Validation

**All user inputs validated with Zod**:
```typescript
const VaultsQuery = z.object({
  authority: z.string().length(44), // Base58 pubkey length
  status: z.enum(['Funding', 'Active', 'Matured', 'Canceled']).optional(),
  limit: z.coerce.number().min(1).max(100).default(50)
});
```

**Sanitization**:
- No SQL/NoSQL injection (Redis string keys only)
- No XSS (JSON responses only, no HTML)
- PDA validation: Ensure 32-byte pubkey format

---

## 6. Performance & Caching

### 6.1 Cache Strategy

**Edge Caching** (Vercel CDN):
```
Cache-Control: s-maxage=30, stale-while-revalidate=60
```

- **s-maxage=30**: Edge cache fresh for 30s
- **stale-while-revalidate=60**: Serve stale for 60s while revalidating in background

**ETag Support**:
```typescript
const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
if (req.headers['if-none-match'] === etag) {
  return res.status(304).end();
}
res.setHeader('ETag', etag);
```

**Cache Hit Rates** (projected):
- `/api/vaults` → 95% (vault data changes infrequently)
- `/api/positions` → 85% (positions update on deposit/claim)
- `/api/activity` → 70% (new activity arrives frequently)

### 6.2 KV Performance

**Expected Latency**:
- Single GET: 1-3ms (Upstash global replication)
- Batch GET (10 keys): 5-10ms (pipelined)
- SMEMBERS (100 items): 2-5ms
- ZREVRANGEBYSCORE (50 items): 3-8ms

**Optimization Techniques**:
1. **Pipeline batching**: Fetch multiple keys in parallel
2. **Denormalization**: Store computed fields (avoid joins)
3. **Index pruning**: Only index what's queried

### 6.3 Scalability Projections

| Metric | MVP (Month 1) | Growth (Year 1) | Notes |
|--------|---------------|-----------------|-------|
| Vaults | 10 | 1,000 | ~500KB storage |
| Users | 100 | 10,000 | |
| Positions | 500 | 50,000 | ~25MB storage |
| Activity events | 5K | 500K | ~250MB (30-day TTL) |
| **Total KV storage** | **~2MB** | **~300MB** | Well under 1GB limit |
| **RPC load reduction** | **90%** | **95%** | vs. direct frontend queries |

**Bottleneck Analysis**:
- **KV limits**: 1GB storage, 10K req/s (Upstash Pro plan)
- **Vercel limits**: 10s timeout, 512MB memory per function
- **Helius limits**: 1M webhook events/mo (~$50/mo)

**When to scale**:
- At 500K positions → Consider PostgreSQL migration
- At 100K active users → Add read replicas
- At 10M activity events → Implement event log rotation

---

## 7. Helius Webhook Integration

### 7.1 Webhook Configuration

**Helius Dashboard Setup**:

1. Navigate to: https://dashboard.helius.dev/webhooks
2. Create new webhook:
   - **Type**: Enhanced (Account-level)
   - **Accounts**: `[VitalFiProgramID]`
   - **Transaction Types**: All
   - **Encoding**: base64
   - **URL**: `https://vitalfi-backend.vercel.app/api/webhooks/helius?token={HELIUS_WEBHOOK_SECRET}`

3. Configure retry policy:
   - Max retries: 3
   - Backoff: Exponential (1s, 2s, 4s)

### 7.2 Event Flow

```
On-Chain Event (e.g., deposit)
    ↓
Solana Validator logs transaction
    ↓
Helius indexer detects account change (< 1s latency)
    ↓
Helius webhook HTTP POST to /api/webhooks/helius
    ↓
Backend verifies HMAC + token
    ↓
Decode account data with Anchor BorshCoder
    ↓
Normalize to DTO
    ↓
Write to KV (idempotent)
    ↓
Update indexes (SETs, ZSETs)
    ↓
Respond 200 OK
    ↓
Frontend queries /api/vaults or /api/positions
    ↓
Edge cache returns fresh data (< 30s stale)
```

### 7.3 Decoded Fields Mapping

**Vault Account → VaultDTO**:
```typescript
{
  vaultPda: accountPubkey.toBase58(),
  authority: decoded.authority.toBase58(),
  vaultId: decoded.vaultId.toString(),
  assetMint: decoded.assetMint?.toBase58() || null,
  status: mapStatus(decoded.status), // enum to string
  cap: decoded.cap?.toString() || null,
  totalDeposited: decoded.totalDeposited?.toString() || null,
  fundingEndTs: decoded.fundingEndTs?.toString() || null,
  maturityTs: decoded.maturityTs?.toString() || null,
  slot: webhookPayload.slot,
  updatedAt: new Date().toISOString()
}
```

**Position Account → PositionDTO**:
```typescript
{
  positionPda: accountPubkey.toBase58(),
  vaultPda: decoded.vault.toBase58(),
  owner: decoded.owner.toBase58(),
  deposited: decoded.deposited?.toString() || null,
  claimed: decoded.claimed?.toString() || null,
  slot: webhookPayload.slot,
  updatedAt: new Date().toISOString()
}
```

### 7.4 Log Message Parsing

**Instruction Detection Regex**:
```typescript
const patterns = {
  deposit: /Instruction: Deposit/i,
  claim: /Instruction: Claim/i,
  finalizeFunding: /Instruction: FinalizeFunding/i,
  matureVault: /Instruction: MatureVault/i,
  // ... etc
};

for (const log of logMessages) {
  for (const [type, pattern] of Object.entries(patterns)) {
    if (pattern.test(log)) {
      // Create ActivityDTO with type
    }
  }
}
```

**Amount Extraction** (if available in logs):
```typescript
const amountMatch = log.match(/amount[:\s]+(\d+)/i);
const amount = amountMatch ? amountMatch[1] : null;
```

---

## 8. Development Workflow

### 8.1 Local Development

**Setup**:
```bash
cd ~/Documents/Cambi/vitalfi-backend
npm install
cp .env.example .env.local
# Fill in KV credentials and secrets
npm run dev
```

**Test Health**:
```bash
curl http://localhost:3000/api/health
# Expected: { "ok": true, "kv": true, "timestamp": "..." }
```

**Test Webhook** (mock Helius):
```bash
# Generate HMAC signature
export SECRET="your-helius-secret"
export PAYLOAD='{"accountData":[],"slot":123,"blockTime":1697812345}'
export SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST "http://localhost:3000/api/webhooks/helius?token=$SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Helius-Signature: $SIG" \
  -d "$PAYLOAD"
```

**Test Vaults Endpoint**:
```bash
curl "http://localhost:3000/api/vaults?authority=11111111111111111111111111111111"
```

### 8.2 Testing Strategy

**Unit Tests** (`tests/*.test.ts`):
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

**Coverage Areas**:
- ✅ Health endpoint returns 200
- ✅ KV get/set JSON works
- ✅ Webhook HMAC verification (valid/invalid)
- ✅ Anchor account decoding (vault/position)
- ✅ DTO normalization
- ✅ API contract validation (shape, headers)
- ✅ ETag generation and 304 responses
- ✅ Pagination cursor logic

**Integration Tests** (manual for MVP):
- Deploy to Vercel preview
- Point Helius webhook to preview URL
- Trigger real transactions on devnet
- Verify data appears in KV and APIs

### 8.3 Deployment

**Environment Setup** (Vercel Dashboard):
```
KV_REST_API_URL=https://...upstash.io
KV_REST_API_TOKEN=AXX1A...
HELIUS_WEBHOOK_SECRET=random-256-bit-secret
HELIUS_API_KEY=your-helius-api-key
VITALFI_PROGRAM_ID=146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj
NEXT_PUBLIC_SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
CACHE_TTL=30
STORAGE_PREFIX=vitalfi:
```

**Deploy Command**:
```bash
vercel --prod
```

**Post-Deployment**:
1. Verify health: `curl https://vitalfi-backend.vercel.app/api/health`
2. Update Helius webhook URL to production
3. Test with real devnet transaction
4. Monitor Vercel logs for errors

---

## 9. Monitoring & Observability

### 9.1 Logging

**Structured Logging** (`src/lib/logger.ts`):
```typescript
logger.info({
  method: 'POST',
  path: '/api/webhooks/helius',
  duration: 123,
  status: 200,
  processed: { vaults: 1, positions: 0, activities: 1 }
});
```

**Redaction**: Automatically redact `HELIUS_WEBHOOK_SECRET`, `KV_REST_API_TOKEN`

**Log Destinations**:
- Development: `console.log`
- Production: Vercel Logs → Forward to DataDog/LogDrain (optional)

### 9.2 Metrics (Future)

**Key Metrics to Track**:
- Webhook processing time (p50, p95, p99)
- KV operation latency
- Cache hit rate by endpoint
- Error rate by endpoint
- Helius webhook retry count

**Tools**:
- Vercel Analytics (built-in)
- Upstash Analytics (KV metrics)
- Optional: Add DataDog APM

### 9.3 Alerts

**Critical Alerts** (configure in production):
- Health check fails (5min downtime)
- Error rate > 5% (10min window)
- KV latency > 100ms (p95)
- Helius webhook failures > 10/hour

---

## 10. Migration Plan (Frontend Integration)

### 10.1 Phase 1: Parallel Run (Week 1)

**Goal**: Backend APIs available, frontend still uses RPC

**Tasks**:
1. Deploy backend to production
2. Configure Helius webhooks
3. Verify data populates KV correctly
4. Monitor for 1 week, ensure stability

**Success Criteria**:
- 99.9% uptime
- < 5% error rate
- Data in KV matches on-chain state

### 10.2 Phase 2: Gradual Migration (Week 2-3)

**Goal**: Frontend switches to backend APIs with feature flag

**Frontend Changes** (`vitalfi-app`):

**New Hooks**:
```typescript
// src/lib/api/backend.ts
export async function fetchVaults(params: VaultsQuery) {
  const url = new URL('/api/vaults', process.env.NEXT_PUBLIC_BACKEND_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: { 'If-None-Match': cachedEtag }
  });

  if (res.status === 304) return cachedData;
  return res.json();
}

// src/hooks/useVaultsAPI.ts
export function useVaultsAPI(params: VaultsQuery) {
  return useQuery({
    queryKey: ['vaults-api', params],
    queryFn: () => fetchVaults(params),
    staleTime: 30_000 // Match backend cache
  });
}
```

**Feature Flag** (`.env.local`):
```env
NEXT_PUBLIC_USE_BACKEND_API=true
```

**Conditional Logic**:
```typescript
export function useFundingVault() {
  const useBackend = process.env.NEXT_PUBLIC_USE_BACKEND_API === 'true';

  if (useBackend) {
    return useFundingVaultAPI(); // Calls backend
  } else {
    return useFundingVaultRPC(); // Direct RPC (existing)
  }
}
```

**Rollout**:
1. Enable for 10% of users (Vercel edge config)
2. Monitor error rates, compare data consistency
3. Increase to 50%, then 100%
4. Deprecate RPC hooks

### 10.3 Phase 3: Cleanup (Week 4)

**Goal**: Remove RPC hooks, backend is source of truth

**Tasks**:
1. Delete `src/lib/vault-sdk/fetchers.ts` (RPC queries)
2. Delete old hooks: `useVault`, `usePosition`, `useUserPositions`
3. Keep only write hooks: `useDeposit`, `useClaim`
4. Update docs

**Final State**:
- Frontend: React Query → Backend APIs (reads), RPC (writes)
- Backend: Helius → KV → APIs
- RPC usage: 90% reduction

---

## 11. Future Enhancements

### 11.1 Phase 2 Features (Post-MVP)

**Advanced Caching**:
- Add Redis EXPIRE to activity events (30-day TTL)
- Implement background cache warming for hot vaults

**Enhanced Activity Parsing**:
- Parse CPI events (cross-program calls)
- Extract amounts from instruction data (not just logs)
- Decode memo fields if present

**Analytics**:
- Aggregate stats: total TVL, daily volume, unique users
- Historical snapshots (daily vault states)

**Notifications**:
- Webhook to frontend for vault matured events
- Email/SMS alerts for claim readiness

### 11.2 Phase 3: Advanced Features

**Full-Text Search**:
- Add Typesense/Algolia for vault name/description search
- Search by asset mint, originator, etc.

**GraphQL API**:
- Replace REST with GraphQL for flexible queries
- Use Pothos or TypeGraphQL

**Multi-Program Support**:
- Index multiple Solana programs
- Shared infrastructure for future VitalFi products

**Historical Data**:
- Store snapshots in S3/R2 for analytics
- Time-series queries: TVL over time, APY trends

---

## 12. Risk Assessment & Mitigation

### 12.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Helius downtime** | Low | High | Implement fallback RPC poller (cron) |
| **KV storage limit** | Medium | Medium | Add TTL to activity, monitor usage |
| **Webhook replay attacks** | Low | Medium | Add timestamp validation (5min window) |
| **Anchor IDL changes** | Medium | High | Version IDL, handle both old/new formats |
| **Vercel cold starts** | High | Low | Accept 1-2s latency on first request |

### 12.2 Operational Risks

| Risk | Mitigation |
|------|------------|
| **Data inconsistency** (webhook missed) | Health check compares KV vs RPC, backfill script |
| **Rate limiting** (Vercel/Helius) | Monitor usage, upgrade plans proactively |
| **Secret exposure** | Rotate secrets quarterly, use Vercel env vars |
| **Breaking API changes** | API versioning (`/api/v1/vaults`) |

---

## 13. Success Metrics

### 13.1 MVP Goals (Month 1)

- ✅ 99% uptime (max 7h downtime/month)
- ✅ < 100ms p95 API latency
- ✅ 90% RPC load reduction on frontend
- ✅ < $100/mo operating cost (Helius + Vercel + KV)

### 13.2 Performance Benchmarks

| Metric | Target | Measurement |
|--------|--------|-------------|
| Webhook processing time | < 200ms | Vercel logs |
| API response time (cached) | < 50ms | Edge analytics |
| API response time (uncached) | < 200ms | Vercel logs |
| Cache hit rate | > 80% | Custom headers |
| Data freshness | < 30s | Compare KV vs RPC |

### 13.3 User Impact

**Before Backend**:
- Portfolio page load: 2-4s (N+1 RPC queries)
- Vault list load: 1-3s (scan all vaults)
- Activity feed: 3-5s (parse transactions)

**After Backend**:
- Portfolio page load: < 500ms (single API call)
- Vault list load: < 300ms (cached edge response)
- Activity feed: < 400ms (indexed ZSET query)

**70-80% latency reduction**

---

## 14. Acceptance Criteria

### 14.1 Functional Requirements

- ✅ Health endpoint returns 200 with KV connectivity check
- ✅ Webhook verifies HMAC and token, rejects invalid requests
- ✅ Webhook decodes Vault and Position accounts correctly
- ✅ Webhook writes to KV idempotently (retry-safe)
- ✅ Webhook creates activity events from logs
- ✅ `/api/vaults` returns list filtered by authority and status
- ✅ `/api/positions` returns list filtered by owner
- ✅ `/api/activity` returns paginated events with cursor
- ✅ All read endpoints return ETag and support 304
- ✅ All read endpoints set stale-while-revalidate cache headers

### 14.2 Non-Functional Requirements

- ✅ TypeScript strict mode with no `any` types
- ✅ All inputs validated with Zod schemas
- ✅ All errors logged with context
- ✅ All endpoints timeout in < 10s (Vercel limit)
- ✅ Unit tests cover 70%+ of logic
- ✅ README with setup and deployment instructions
- ✅ `.env.example` with all required variables

---

## 15. Open Questions & Decisions

### 15.1 Resolved

✅ **Q**: Should we use Postgres or Redis?
**A**: Redis (KV) for simplicity, no schema migrations, fast reads.

✅ **Q**: How to handle transaction history?
**A**: Parse Helius logs, store as activity events, paginate with ZSET.

✅ **Q**: What about rate limiting?
**A**: Use Vercel built-in for MVP, add Upstash Rate Limit later.

### 15.2 Open (To Address in Implementation)

🔲 **Q**: Should we cache decoded Anchor IDL in memory?
**Option A**: Load once on cold start (faster, uses memory)
**Option B**: Load on each webhook (slower, stateless)
**Decision**: Defer to implementation, likely Option A.

🔲 **Q**: How to handle Anchor IDL version upgrades?
**Option A**: Support both old/new IDL, detect by account size
**Option B**: Hard cutover, backfill old data
**Decision**: TBD based on program upgrade strategy.

🔲 **Q**: Should we add GraphQL later?
**Decision**: Start with REST, evaluate after 3 months.

---

## 16. Timeline & Milestones

### Week 1: Foundation
- [ ] Scaffold project structure
- [ ] Implement KV helpers and keyspace
- [ ] Set up health endpoint and tests
- [ ] Deploy to Vercel staging

### Week 2: Webhook Integration
- [ ] Implement HMAC verification
- [ ] Add Anchor decoding logic
- [ ] Write webhook handler
- [ ] Test with mock Helius payloads
- [ ] Configure real Helius webhook (devnet)

### Week 3: Read APIs
- [ ] Implement `/api/vaults`
- [ ] Implement `/api/positions`
- [ ] Implement `/api/activity`
- [ ] Add ETag and cache logic
- [ ] Write API contract tests

### Week 4: Production & Handoff
- [ ] Deploy to production (mainnet)
- [ ] Configure monitoring and alerts
- [ ] Write integration guide for frontend team
- [ ] Load test with realistic data
- [ ] Document runbook

**Total Estimated Time**: 4 weeks (1 developer, full-time)

---

## 17. Appendix

### A. Keyspace Quick Reference

```
# Data
vault:{pda}:json
position:{pda}:json
activity:{sig}:{type}:{slot}

# Indexes
vaults:set
authority:{pk}:vaults
owner:{pk}:positions
vault:{pda}:activity
owner:{pk}:activity
```

### B. Environment Variables

```bash
# Required
KV_REST_API_URL=https://...upstash.io
KV_REST_API_TOKEN=AXX1A...
HELIUS_WEBHOOK_SECRET=random-256-bit-secret
HELIUS_API_KEY=your-helius-api-key
VITALFI_PROGRAM_ID=146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj

# Optional
NEXT_PUBLIC_SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
CACHE_TTL=30
STORAGE_PREFIX=vitalfi:
```

### C. Useful Commands

```bash
# Dev
npm run dev
npm test
npm run build

# Vercel
vercel dev            # Local with Vercel runtime
vercel deploy         # Deploy preview
vercel --prod         # Deploy production

# KV CLI (Upstash)
redis-cli -u $KV_REST_API_URL
SMEMBERS vitalfi:vaults:set
GET vitalfi:vault:{pda}:json
```

---

**End of Plan** - Ready for implementation. Proceed with scaffold and coding.
