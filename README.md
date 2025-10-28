# VitalFi Backend

**Blockchain indexing and caching layer for healthcare DeFi**

Built by Credit Markets | Part of the VitalFi ecosystem

Lightweight, serverless backend that indexes VitalFi Solana program events and provides efficient REST APIs for vault, position, and activity data.

## Architecture

- **Runtime**: Vercel Serverless Functions (Node.js 22)
- **Storage**: Redis (via Vercel KV)
- **Indexer**: Helius RAW Webhooks
- **Language**: TypeScript (strict mode)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
```

Fill in the required values:

- `REDIS_URL` - Redis connection URL (Vercel KV provides this automatically)
- `HELIUS_WEBHOOK_SECRET` - Generate a random 256-bit secret
- `HELIUS_API_KEY` - From Helius dashboard
- `VITALFI_PROGRAM_ID` - VitalFi program ID (default: `146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj`)

### 3. Run Locally

```bash
npm run dev
```

Server starts at `http://localhost:3000`

### 4. Test Health

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{
  "ok": true,
  "kv": true,
  "timestamp": "2025-10-20T12:00:00.000Z"
}
```

## API Endpoints

### GET /api/health

Health check endpoint.

**Response:**

```json
{
  "ok": true,
  "kv": true,
  "timestamp": "2025-10-20T12:00:00.000Z"
}
```

---

### GET /api/vaults

List vaults by authority.

**Query Params:**

- `authority` (required): Authority pubkey
- `status` (optional): Filter by "Funding" | "Active" | "Matured" | "Canceled"
- `limit` (optional): Max items (default 50, max 100)

**Example:**

```bash
curl "http://localhost:3000/api/vaults?authority=11111111111111111111111111111111"
```

**Response:**

```json
{
  "items": [
    {
      "vaultPda": "...",
      "vaultTokenAccount": "...",
      "authority": "...",
      "vaultId": "1",
      "assetMint": "So11111111111111111111111111111111111111112",
      "status": "Funding",
      "cap": "100000000000",
      "totalDeposited": "50000000000",
      "totalClaimed": "0",
      "targetApyBps": 500,
      "minDeposit": "1000000",
      "fundingEndTs": "1729468800",
      "maturityTs": null,
      "payoutNum": null,
      "payoutDen": null,
      "slot": 123456789,
      "updatedAt": "2025-10-20T12:00:00.000Z",
      "updatedAtEpoch": 1697900000
    }
  ],
  "nextCursor": 1697900000,
  "total": 1
}
```

---

### GET /api/positions

List positions for a user.

**Query Params:**

- `owner` (required): User wallet pubkey
- `limit` (optional): Max items (default 50, max 100)

**Example:**

```bash
curl "http://localhost:3000/api/positions?owner=11111111111111111111111111111111"
```

---

### GET /api/activity

Paginated activity feed for a vault or user.

**Query Params:**

- `vault` (optional): Vault PDA - exactly one of vault/owner required
- `owner` (optional): User pubkey
- `cursor` (optional): ISO timestamp for pagination
- `limit` (optional): Page size (default 50, max 100)

**Example:**

```bash
curl "http://localhost:3000/api/activity?vault=Vault..."
curl "http://localhost:3000/api/activity?owner=Owner...&cursor=2025-10-20T12:00:00.000Z&limit=20"
```

**Response:**

```json
{
  "items": [
    {
      "id": "sig:deposit:123",
      "txSig": "...",
      "slot": 123456789,
      "blockTime": "2025-10-20T12:00:00.000Z",
      "type": "deposit",
      "vaultPda": "...",
      "owner": "...",
      "amount": "1000000000"
    }
  ],
  "nextCursor": "2025-10-20T11:59:00.000Z",
  "total": null
}
```

---

### POST /api/webhooks/helius?token={secret}

Receives account update events from Helius.

**Authentication:**

- `X-Helius-Signature` header (HMAC SHA256)
- `?token` query param must match `HELIUS_WEBHOOK_SECRET`

**Setup:**

1. Go to https://dashboard.helius.dev/webhooks
2. Create new webhook:
   - Type: RAW
   - Accounts: `[VitalFiProgramID]`
   - Encoding: base64
   - URL: `https://your-backend.vercel.app/api/webhooks/helius?token={HELIUS_WEBHOOK_SECRET}`

---

## Deployment

### 1. Link to Vercel Project

```bash
vercel link
```

### 2. Set Environment Variables

In Vercel dashboard, add all variables from `.env.local` to your project settings.

### 3. Deploy

```bash
vercel --prod
```

### 4. Configure Helius Webhook

Update Helius webhook URL to point to your production deployment:

```
https://your-backend.vercel.app/api/webhooks/helius?token={your-secret}
```

---

## Testing

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Build TypeScript
npm run build
```

---

## KV Keyspace

| Key                            | Type   | Purpose                               |
| ------------------------------ | ------ | ------------------------------------- |
| `vault:{pda}:json`             | STRING | Vault data                            |
| `position:{pda}:json`          | STRING | Position data                         |
| `activity:{sig}:{type}:{slot}` | STRING | Activity event                        |
| `vaults:set`                   | SET    | All vault PDAs                        |
| `authority:{pk}:vaults`        | SET    | Vaults by authority                   |
| `owner:{pk}:positions`         | SET    | Positions by owner                    |
| `vault:{pda}:activity`         | ZSET   | Activity for vault (score: blockTime) |
| `owner:{pk}:activity`          | ZSET   | Activity for owner (score: blockTime) |

---

## Architecture Diagram

```
Solana → Helius → POST /api/webhooks/helius → KV → GET /api/* → Frontend
```

---

## Troubleshooting

**HMAC verification fails:**

- Ensure `HELIUS_WEBHOOK_SECRET` matches in Helius dashboard and `.env.local`
- Check that raw body is used (not parsed JSON)

**Redis connection fails:**

- Verify `REDIS_URL` is set correctly (Vercel KV provides this automatically)
- Check Vercel KV is provisioned and linked to your project
- Ensure the redis client singleton is properly initialized

**404 on endpoints:**

- Ensure file paths match Vercel routing: `src/api/*.ts` → `/api/*`
- Check `vercel.json` configuration

---

## Links

- **VitalFi App:** https://app.vitalfi.lat
- **VitalFi Docs:** https://docs.vitalfi.lat
- **Landing Page:** https://vitalfi.lat
- [Vercel Docs](https://vercel.com/docs)
- [Helius Docs](https://docs.helius.dev)
- [Anchor Docs](https://www.anchor-lang.com/)

---

**Powered by Credit Markets | Built on Solana**

_Earn Yield. Empower Healthcare._
