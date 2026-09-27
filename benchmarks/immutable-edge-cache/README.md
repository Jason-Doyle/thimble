# Authorization-gated immutable-object edge-cache experiment

This harness compares the current direct R2 read path with a temporary
Cloudflare Cache API layer for encrypted content-addressed objects.

The candidate does not cache collection HEAD objects. Every request is
authorized before cache lookup, and the browser still validates and decrypts
the same TDB1 object bytes.

## Measured paths

- direct R2 reads through the authorization gate
- forced edge-cache misses
- cold browser clients with prewarmed edge objects
- Snapshot and Trie point reads
- Snapshot and Trie point-read bundles
- covered equality and range queries
- uncovered equality queries
- complete scans
- small, medium, and large deterministic profiles

The primary timer is caller-observed end-to-end latency from disposable Azure
Node 22 clients. R2 reads, R2 bytes, edge-cache hits, and edge-cache misses
are retained separately.

## Preparation

```powershell
$env:THIMBLE_BENCHMARK_SOURCE_COMMIT = "<main commit>"
$env:THIMBLE_BENCHMARK_HARNESS_COMMIT = "<experiment commit>"
npm run benchmark:edge-cache:regional:generate
npm run benchmark:edge-cache:regional:build
```

Generated fixtures, the runner bundle, deployment configuration, tokens, and
downloaded regional results remain below the ignored
`.bench-data/immutable-edge-cache` directory.

After deploying the temporary Worker and bucket:

```powershell
$env:THIMBLE_BENCHMARK_TARGET = "<temporary workers.dev URL>"
$env:THIMBLE_BENCHMARK_TOKEN = "<temporary token>"
npm run benchmark:edge-cache:regional:upload
```

## Evidence layout

```text
.bench-data/immutable-edge-cache/results/read-a/<region>.json
.bench-data/immutable-edge-cache/results/read-b/<region>.json
```

Aggregate with:

```powershell
npm run benchmark:edge-cache:regional:aggregate
```

The default artifact is:

```text
evidence/immutable-edge-cache-regional-worker-2026-09-27.json
```

No production Worker, bucket, route, domain, package export, or storage
protocol is used or changed by this experiment.
