# Benchmarks and evidence

ThimbleDB claims only what the current artifacts measure.

## Reproduce

```powershell
npm install
npm run benchmark -- --provider local --profile small --latency-ms 8
```

Azure:

```powershell
$env:AZURE_STORAGE_CONNECTION_STRING = "<set locally>"
$env:AZURE_STORAGE_CONTAINER = "object-db-poc"
npm run benchmark -- --provider azure --profile small
```

The harness writes raw JSON results to `benchmark-results`. Credentials and
URLs are not included in result artifacts.

## Workload

The `small` store profile contains:

- 512 products
- 128 customers
- 512 orders
- 100 point reads
- 5 catalogue scans
- 50 sequential updates
- 40 concurrent writes
- 20 checkout-shaped operations

It compares monolithic JSON, append-log snapshots, and the content-addressed
trie under cold, location-only, and full-content caches.

## Azure Standard result

Raw artifact:

```text
evidence/azure-standard-small.json
```

The test ran from a developer workstation against Azure Standard Blob Storage
with no simulated latency.

| Engine | Cold read p50 | Location-cache p50 | Location bytes/read | Content-cache p50 | Update p50 | Update bytes/write | Concurrent p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Monolithic JSON | 64.34 ms | 64.58 ms | 187.924 KB | 0.44 ms | 154.15 ms | 188.896 KB | 27,469.38 ms |
| Log + snapshot | 168.84 ms | 115.95 ms | 187.943 KB | 54.87 ms | 110.21 ms | 0.614 KB | 2,543.24 ms |
| Trie | 212.21 ms | 52.94 ms | 1.033 KB | 0.05 ms | 277.93 ms | 3.265 KB | 12,623.22 ms |

Measured conclusions:

- Full content caching dominates repeated-read latency.
- Location-only caching gives the trie a large transfer-size advantage.
- One mutable root performs poorly under a burst of concurrent writes.
- Monolithic JSON remains credible for small, rarely changed collections.
- Append-log snapshots gave the best balanced write path in this workload.

These results predate the browser-first encrypted envelope implementation.
They validate the storage-shape decision, not final production performance.

## Live R2 multi-region browser result

Raw artifacts:

```text
evidence/r2-browser-multiregion-trie-2026-09-24.json
evidence/r2-browser-multiregion-snapshot-2026-09-24.json
```

Disposable Chromium 153 containers ran in Azure North Europe, US East, and
Southeast Asia against the real `https://db.thimbledb.com` Worker, private R2
buckets, and Entra session exchange.

Initial run, product trie, customer snapshot, one-second HEAD TTL:

| Region | Auth | Cold product | Hot p50 | Hot p95 | Customer scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| North Europe | 8,068.2 ms | 4,149.0 ms | 0.3 ms | 1,908.6 ms | 1,959.2 ms |
| US East | 5,348.6 ms | 2,550.0 ms | 0.3 ms | 1,319.0 ms | 1,250.4 ms |
| Southeast Asia | 16,137.3 ms | 4,844.9 ms | 1,216.0 ms | 2,559.9 ms | 3,122.4 ms |

The four sequential trie object requests missed the cold-read threshold. In
Southeast Asia, one round trip exceeded the one-second HEAD TTL, so every hot
read revalidated HEAD.

Evidence-driven reference change, product and customer snapshots, ten-second
HEAD TTL:

| Region | Auth | Cold product | Hot p50 | Hot p95 | Customer scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| North Europe | 8,619.9 ms | 1,933.9 ms | 0.9 ms | 8.3 ms | 1,713.8 ms |
| US East | 4,933.4 ms | 1,247.0 ms | 0.8 ms | 5.2 ms | 949.2 ms |
| Southeast Asia | 12,717.9 ms | 3,439.6 ms | 0.7 ms | 1.6 ms | 3,006.9 ms |

Measured conclusions:

- Snapshot layout reduced product cold-read time by 29-53 percent.
- The ten-second HEAD TTL removed repeated regional revalidation from the
  100-read loop.
- Warm in-memory reads were sub-millisecond at p50 in all three regions.
- Cold reads and external session creation remain well above the original
  latency targets.
- Azure regions approximate geography but do not represent residential
  last-mile networks.
- The result supports adaptive layout selection for this workload. It does not
  establish superiority over another database.

## Evidence still required

Before claiming a user benefit, measure:

- first load, warm memory, warm IndexedDB, and offline reads
- gzip ratio and CPU cost by object-size bucket
- AES-GCM and device-cache encryption cost
- key-grant latency
- Worker CPU time and subrequest counts
- R2 Class A and Class B operations per user action
- contention after partitioning or sharding collection roots
- cost at idle and at representative small-app traffic

## Stop/go thresholds

The trie should not become the only storage model unless it can show:

- at least 5x fewer transferred bytes than a cached snapshot for point reads
- warm IndexedDB reads within 2x of plain IndexedDB JSON
- encrypted first-read p95 below 250 ms from the reference Cloudflare region
- fewer than two conditional-write retries at p95 for normal small-app traffic
- maintenance below 10 percent of write operations

The live R2 run missed the cold-read threshold, so the reference deployment
uses an adaptive layout:

- compressed immutable snapshot for small collections
- sharded pages only when measured size or access patterns justify them
