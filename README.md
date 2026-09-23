# ThimbleDB

ThimbleDB is a Cloudflare-first browser database experiment for very small web
applications. Browsers read immutable binary envelopes directly from R2
through memory and encrypted IndexedDB caches. Authenticated writes and
decryption-key grants go through a small Worker authority.

The same protocol also runs against Azure Blob Storage and Amazon S3 as
secondary deployment options.

`VibeDB` was rejected because that name is already used on npm, PyPI, GitHub,
and Devpost. `ThimbleDB` had no identified package, database, or product
collision when this POC was named.

```text
Browser
  memory LRU
  encrypted IndexedDB persistent cache
  direct encrypted R2 reads
              |
              | POST mutation
              v
Cloudflare Worker
  session and scope authorisation
  short-lived key grant
  validation
  adaptive gzip
  AES-256-GCM
  immutable node writes
  conditional HEAD update
  maintenance
```

The production browser bundle is framework-free TypeScript. The current build
is about 19.5 KB uncompressed and 6.7 KB gzip. IndexedDB, Web Crypto,
BroadcastChannel, and Web Locks are native browser APIs. No database runtime or
WASM module is shipped.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Object protocol](docs/PROTOCOL.md)
- [Benchmarks and raw evidence](docs/BENCHMARKS.md)
- [Tradeoffs](docs/TRADEOFFS.md)
- [Cloudflare deployment](docs/DEPLOYMENT-CLOUDFLARE.md)
- [Azure deployment](docs/DEPLOYMENT-AZURE.md)
- [AWS deployment](docs/DEPLOYMENT-AWS.md)
- [Operations](docs/OPERATIONS.md)
- [Release strategy](docs/RELEASE-STRATEGY.md)

## Browser POC

Run the local write authority and Vite client together:

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The UI can:

- seed a deterministic online-store dataset
- read one product through memory, IndexedDB, and object storage
- switch between no cache, location-only cache, and full-content cache
- run 100 hot reads or a collection scan
- clear memory separately from persistent cache
- mutate product stock through the server write path
- display remote reads, transferred bytes, cache hits, ETag 304 responses,
  offline fallbacks, and retained memory

For a production-style local run:

```powershell
npm run build
npm run start:prod
```

Open `http://127.0.0.1:8787`. Local durable objects are stored below
`.thimble-data`.

### Browser cache behaviour

| Object | Cache behaviour |
| --- | --- |
| `HEAD.json` | Memory and device-key-encrypted IndexedDB with configurable TTL and ETag revalidation |
| Root and branch nodes | Immutable and safe to retain indefinitely |
| Leaf nodes and documents | Retained under the content policy, fetched on demand under the locations policy |
| Decoded hot values | Bounded in-memory LRU |

The client requests persistent browser storage when available. IndexedDB
entries are encrypted with a separate non-extractable device key. The
server-issued scope key remains memory-only. If HEAD
revalidation fails while offline, it falls back to the cached HEAD and
immutable nodes. A successful server write returns the new HEAD, root, branch,
and leaf objects so the writing tab updates immediately. BroadcastChannel
shares that bundle with other open tabs.

The POC uses one global mutable HEAD TTL:

```powershell
$env:THIMBLE_HEAD_TTL_MS = "1000"
```

Per-collection and per-object TTL policy is a likely production extension.

### Cloudflare reference deployment

The flagship deployment is a Worker, an R2 binding, static Worker assets, and
an encrypted R2 custom-domain read path:

```powershell
npm run build:client
npm run build:worker
```

Use the disabled configuration example under
`deploy\cloudflare\wrangler.example.jsonc` and follow
`docs\DEPLOYMENT-CLOUDFLARE.md`.

### Azure browser reads

The write authority uses the storage account connection string. The browser
must receive only a short-lived, read-only URL, ideally a user-delegation SAS
scoped to the application's tenant directory or container.

```powershell
$env:THIMBLE_PROVIDER = "azure"
$env:AZURE_STORAGE_CONNECTION_STRING = "<server-only connection string>"
$env:AZURE_STORAGE_CONTAINER = "thimbledb"
$env:THIMBLE_PREFIX = "demo"
$env:THIMBLE_READ_BASE_URL = "https://<account>.blob.core.windows.net/thimbledb/demo?<read-only-sas>"
$env:THIMBLE_MASTER_KEY = "<base64-encoded 32-byte key>"
npm run dev
```

Do not put the account key or write-capable SAS in browser code. Configure Blob
Storage CORS for the exact web origin:

- methods: `GET`, `HEAD`, `OPTIONS`
- allowed request header: `If-None-Match`
- exposed response header: `ETag`

ThimbleDB validates the Azure browser URL at startup. It must use HTTPS, end
with the configured `/<container>/<prefix>` path, include a signature, and
grant read permission only (`sp=r`). The server refuses write-, create-, or
delete-capable browser SAS tokens.

The browser does not need blob listing permission because it follows hashes
from `HEAD.json`.

## Storage layout benchmark

The original benchmark remains in this repository to compare the trie with
two simpler persistence models.

It compares three deliberately small designs:

| Engine | Storage model | Expected strength | Expected weakness |
| --- | --- | --- | --- |
| Monolithic JSON | One mutable object per collection | Minimal requests and excellent scans | Rewrites the collection and has severe write contention |
| Append log + snapshot | Immutable numbered log entries with periodic snapshots | Simple commits and efficient append behaviour | Reads replay the un-compacted tail |
| Content-addressed trie | Immutable two-level hash trie with a CAS-updated root | Small point-read payloads, structural sharing and snapshots | More requests, root contention and garbage collection |

The log engine is inspired by Baerly's documented protocol, but this is an
independent benchmark model rather than a Baerly compatibility implementation.
The trie is intentionally simple: the first two SHA-256 nibbles select one of
256 leaf shards, and every mutation copy-on-writes the affected leaf, branch,
root, and `HEAD.json`.

## Workload

The deterministic sample application is a small online store containing:

- products with categories, stock and descriptions
- customers with addresses
- orders with line items

Each engine runs the same phases:

1. Seed products, customers and orders, then establish a compacted baseline.
2. Perform cold, location-cached, and content-cached product lookups.
3. Compare the same three cache modes for catalogue scans.
4. Apply sequential product updates.
5. Race concurrent writes to one collection.
6. Run a content-cached checkout-shaped flow: read a product, decrement stock, and insert an
   order.
7. Run maintenance and verify a post-maintenance read.

The checkout is deliberately not presented as an atomic transaction. None of
the POC engines provides cross-collection atomicity.

For every phase the harness records:

- elapsed time and scenario p50/p95 latency
- GET, PUT, DELETE and LIST operations
- bytes read and written
- cache policy, hit rate, retained entries and retained bytes
- failed conditional writes and engine retries
- final object count and stored bytes

### Benchmark cache policies

Warm memory is part of the intended architecture rather than an optional
afterthought. The benchmark separates three policies:

| Policy | Cached objects | Purpose |
| --- | --- | --- |
| `none` | Nothing | Models a cold process or cache miss |
| `locations` | Mutable heads plus trie root and branch routing nodes | Avoid repeated path discovery while still loading current content |
| `content` | All fetched objects | Models a warm application instance serving mostly unchanged data |

Immutable log entries, snapshots and trie nodes can remain cached without a
freshness timer under the full-content policy because their keys never change.
Mutable objects such as `HEAD.json`, `current.json`, and monolithic collection
files use a configurable TTL and are replaced or invalidated after local
writes and failed compare-and-swap operations.

The POC uses one global mutable-object TTL:

```powershell
npm run benchmark -- --mutable-cache-ttl-ms 1000
```

A production design should allow TTL policy to be selected per object type,
collection, tenant, or application. For example, catalogue documents might be
cached for minutes while inventory heads require a much shorter freshness
window. That additional policy surface is intentionally outside this POC.

### Run the benchmark locally

Install dependencies and run the tiny workload with 8 ms of simulated latency
per object-store operation:

```powershell
npm install
npm run benchmark:local
```

Run without simulated latency or use the larger sample:

```powershell
npm run benchmark -- --provider local --profile tiny --latency-ms 0
npm run benchmark -- --provider local --profile small --latency-ms 8
npm run benchmark -- --profile tiny --cache-max-mb 128
```

Each run prints comparison tables and writes the complete measurements to
`benchmark-results\<run-id>.json`. Local object data is written below
`.bench-data`; both directories are ignored by Git.

### Run the benchmark against Azure Blob Storage

Do not paste a storage key into source, a command argument, or this repository.
Set the connection string in the current shell so the Azure SDK reads it at
runtime:

```powershell
$env:AZURE_STORAGE_CONNECTION_STRING = "<set locally>"
$env:AZURE_STORAGE_CONTAINER = "object-db-poc"
npm run benchmark:azure
Remove-Item Env:AZURE_STORAGE_CONNECTION_STRING
```

The container is created if it does not exist. Every run uses a unique object
prefix and does not overwrite another run.

The Azure adapter relies on ETag conditions:

- `If-None-Match: *` for immutable object creation
- `If-Match: <etag>` for root or collection compare-and-swap

### Run the benchmark against S3 or an S3-compatible service

The AWS adapter uses the normal AWS SDK credential chain. It does not accept
credentials as command arguments:

```powershell
$env:S3_BUCKET = "my-benchmark-bucket"
$env:AWS_REGION = "us-east-1"
npm run benchmark:s3
```

For MinIO or another compatible endpoint:

```powershell
$env:S3_ENDPOINT = "https://object-storage.example.test"
$env:S3_FORCE_PATH_STYLE = "true"
```

The target must provide strongly consistent reads and atomic conditional
`PutObject` behaviour for `If-Match` and `If-None-Match`. Provider compatibility
should be tested rather than inferred from an S3-compatible API label.

### Decision criteria

The trie is worth another iteration only if real cloud measurements show a
useful advantage that justifies its additional machinery. Evidence should
include:

- materially fewer bytes or lower point-read latency at representative sizes
- a useful location-cache mode that avoids loading stale content
- a full-content cache that produces high hit rates without unsafe invalidation
- acceptable object-operation cost
- controlled CAS retry rates under concurrent writes
- maintenance that does not dominate the workload
- a clear benefit over a log plus snapshot after both are sensibly optimised

The simplest JSON model is also a valid outcome. For a tiny, mostly idle
application, rewriting a small collection can be cheaper and faster than
maintaining a sophisticated tree.

## POC boundaries

This code is not a production database. It does not provide an application
identity system, automated key rotation, schema evolution, crash-safe
concurrent garbage collection, secondary query indexes, cross-collection
transactions, or automated backups. The local object-store adapter serialises
access only within one Node.js process. Log and trie garbage collection must
run while writes are quiescent.
