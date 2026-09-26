# Current-layout regional benchmark

This harness measures released snapshot, trie, read-bundle, secondary-index,
scan, and write paths against a temporary Cloudflare Worker and R2 bucket.
Disposable Azure Container Instances provide regional callers.

The local machine may generate and upload deterministic fixtures. Measured
operations execute from Azure through the temporary Worker and R2. Do not use
the production ThimbleDB Worker, buckets, routes, or custom domain.

## Profiles

| Profile | Documents |
| --- | ---: |
| Small | 128 |
| Medium | 5,000 |
| Large | 25,000 |

Every layout uses the same encrypted JSON documents and declared equality and
range indexes. The large snapshot decodes below the normal 16 MiB
decoded-envelope limit.

## Measured paths

- cold snapshot and trie point reads through the production browser client
- snapshot and trie point reads through the bounded authority bundle
- covered equality and range queries
- uncovered indexed equality queries
- complete snapshot and trie scans
- single-writer snapshot and trie updates
- simultaneous multi-region snapshot and trie updates
- rejection of a compressed object that expands beyond 16 MiB

The primary timer is the Azure caller's complete operation time. Worker timers
are retained only for I/O-oriented write diagnostics because production
Cloudflare Worker timers do not measure CPU-only work normally.

## Local preparation

```powershell
$env:THIMBLE_BENCHMARK_SOURCE_COMMIT = "<tested commit>"
$env:THIMBLE_BENCHMARK_HARNESS_COMMIT = "<harness commit>"
npm run benchmark:current-regional:generate
npm run benchmark:current-regional:build
```

The generated fixture tree, runner bundle, deployment configuration, and
downloaded regional results remain below the ignored
`.bench-data/current-regional` directory.

## Evidence aggregation

Place each downloaded regional result under:

```text
.bench-data/current-regional/results/read-a/<region>.json
.bench-data/current-regional/results/read-b/<region>.json
.bench-data/current-regional/results/write-a/<region>.json
.bench-data/current-regional/results/write-b/<region>.json
.bench-data/current-regional/results/contention-a/<region>.json
.bench-data/current-regional/results/contention-b/<region>.json
```

Then run:

```powershell
npm run benchmark:current-regional:aggregate
```

The default evidence path is:

```text
evidence/r2-current-layout-multiregion-2026-09-25.json
```

Delete the temporary Worker, every bucket object, the bucket, and the Azure
resource group after retaining and hashing the evidence.
