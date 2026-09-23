# Proof of concept

This document covers the browser harness, sample store, local provider, and
storage-layout benchmark. It is evaluation material rather than the product
overview.

## Run the browser harness

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Configure Entra or a generic OIDC provider, obtain an API access token through
the provider's application flow, select the provider in the harness, and
exchange the token for a ThimbleDB session.

The Playwright suite includes a self-contained signed test provider:

```powershell
npm run test:e2e
```

The UI can:

- seed a deterministic online-store dataset
- read one product through memory, IndexedDB, and object storage
- switch between no cache, location-only cache, and full-content cache
- run 100 hot reads or a collection scan
- clear memory separately from persistent cache
- mutate product stock through the authority
- display remote reads, transferred bytes, cache hits, ETag 304 responses,
  offline fallbacks, and retained memory

For a compiled local run:

```powershell
npm run build
$env:THIMBLE_ALLOWED_ORIGIN = "http://127.0.0.1:8787"
npm run start:prod
```

Open `http://127.0.0.1:8787`.

Local durable objects are stored below `.thimble-data`. The adapter serialises
access only inside one Node process.

## Local encryption behaviour

Encrypted scope mode is the default.

On first local startup:

1. The authority creates a local deployment master key under
   `.thimble-data`.
2. It derives one scope encryption key and one node-address HMAC key.
3. A validated external identity is mapped to a stable internal user UUID.
4. The browser receives an HttpOnly opaque session cookie.
5. The authorised key endpoint returns the scope key once.
6. The browser imports it as a non-extractable memory-only CryptoKey.
7. Persistent cache values are encrypted with a separate non-extractable
   browser device key.

Raw stored objects begin with the `TDB1` envelope magic and do not contain
plaintext JSON.

## Browser cache policies

| Policy | Cached objects | Purpose |
| --- | --- | --- |
| `none` | Nothing | Cold process or cache-miss measurement |
| `locations` | HEAD plus root and branch routing nodes | Avoid path discovery while loading current leaf content |
| `content` | All fetched objects | Warm read-mostly application |

Mutable HEAD uses a configurable TTL:

```powershell
$env:THIMBLE_HEAD_TTL_MS = "1000"
```

Per-collection and per-object TTL policy is a future extension.

## Sample application

The deterministic store contains:

- products with categories, stock, descriptions, and prices
- customers with addresses
- orders with line items

The browser harness uses the same data generator as the storage-layout
benchmark.

## Azure authentication experiment

For a browser test against Azure:

```powershell
$env:THIMBLE_PROVIDER = "azure"
$env:AZURE_STORAGE_CONNECTION_STRING = "<server-only connection string>"
$env:AZURE_STORAGE_CONTAINER = "thimbledb"
$env:AZURE_AUTH_STORAGE_CONTAINER = "thimbledb-auth"
$env:THIMBLE_PREFIX = "demo"
$env:THIMBLE_MASTER_KEY = "<base64-encoded 32-byte key>"
$env:THIMBLE_ALLOWED_ORIGIN = "http://127.0.0.1:5173"
$env:ENTRA_TENANT_ID = "<tenant-id>"
$env:ENTRA_AUDIENCE = "<api-audience>"
$env:ENTRA_REQUIRED_SCOPE = "thimble.access"
npm run dev
```

Private objects are read through the authenticated authority. The auth
container is never exposed to the browser.

See [Deploy to Azure](DEPLOYMENT-AZURE.md) for the complete path.

## Storage-layout benchmark

The original benchmark compares:

| Engine | Storage model | Expected strength | Expected weakness |
| --- | --- | --- | --- |
| Monolithic JSON | One mutable object per collection | Minimal requests and excellent scans | Rewrites the collection and has severe write contention |
| Append log + snapshot | Immutable numbered log entries and periodic snapshots | Efficient append behaviour | Reads replay the uncompacted tail |
| Content-addressed trie | Immutable two-level trie and CAS-updated root | Small point-read payloads and structural sharing | More requests, root contention, and garbage collection |

The log model is inspired by Baerly's documented protocol but is not a
compatibility implementation.

### Workload

Each engine:

1. seeds products, customers, and orders
2. runs cold, location-cached, and content-cached point reads
3. runs catalogue scans under each cache policy
4. applies sequential updates
5. races concurrent writes
6. runs checkout-shaped reads and writes
7. runs maintenance and verifies data afterwards

The harness records:

- elapsed time and p50/p95 latency
- GET, PUT, DELETE, and LIST operations
- bytes read and written
- cache hits and retained bytes
- failed conditional writes and retries
- final object count and stored bytes

### Run locally

```powershell
npm run benchmark:local
npm run benchmark -- --provider local --profile small --latency-ms 8
```

### Run against Azure

```powershell
$env:AZURE_STORAGE_CONNECTION_STRING = "<set locally>"
$env:AZURE_STORAGE_CONTAINER = "object-db-poc"
npm run benchmark -- --provider azure --profile small
Remove-Item Env:AZURE_STORAGE_CONNECTION_STRING
```

### Run against S3 or R2 through the S3 API

```powershell
$env:S3_BUCKET = "<bucket>"
$env:AWS_REGION = "us-east-1"
npm run benchmark -- --provider s3 --profile small
```

R2:

```powershell
$env:S3_BUCKET = "<r2-bucket>"
$env:AWS_REGION = "auto"
$env:S3_ENDPOINT = "https://<account-id>.r2.cloudflarestorage.com"
npm run benchmark -- --provider s3 --profile small
```

The benchmark uses the normal AWS credential chain. Do not put credentials in
command arguments or source files.

## Current evidence

The raw Azure Standard artifact is
`evidence/azure-standard-small.json`.

See [Benchmarks](BENCHMARKS.md) for the measured table, interpretation,
unproven claims, and stop/go thresholds.

## POC boundaries

The harness does not prove:

- production authentication behaviour under real traffic
- automated key rotation
- crash-safe concurrent garbage collection
- cross-collection transactions
- document deletion and retention semantics
- search or analytics
- cost or latency superiority over managed databases

Those boundaries are intentional and documented so evaluation results are not
presented as product claims.
