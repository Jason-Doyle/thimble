# Partitioned secondary-index regional experiment

This harness compares current monolithic secondary-index pages with an
experimental eight-shard layout on the isolated
`experiment/partitioned-secondary-indexes` branch.

The candidate keeps collection HEAD publication atomic:

```text
collection HEAD
  index reference
    partition count
    immutable shard hashes and decoded sizes
```

Each document ID maps deterministically to one shard. A document mutation
rewrites one shard per configured index. Queries read all eight shards in
parallel and merge them before applying the existing index plan.

## Workload

- 25,000 encrypted JSON documents
- Snapshot and Trie document layouts
- equality index covering `title` and `lastModified`
- range index covering `title` and `category`
- covered equality
- uncovered equality
- covered range
- warm re-query after invalidating HEAD and one index object
- single-writer updates
- simultaneous seven-region writes

The warm re-query case preloads all index objects, removes the cached HEAD and
one index object, then repeats the query. It measures the expected fetch after
one partition changes without mutating the shared read fixture.

## Preparation

```powershell
$env:THIMBLE_BENCHMARK_SOURCE_COMMIT = "<implementation commit>"
$env:THIMBLE_BENCHMARK_HARNESS_COMMIT = "<harness commit>"
npm run benchmark:partitioned-index:regional:generate
npm run benchmark:partitioned-index:regional:build
```

All generated fixtures and deployment configuration remain below the ignored
`.bench-data/partitioned-index-regional` directory.

## Evidence layout

```text
.bench-data/partitioned-index-regional/results/read-a/<region>.json
.bench-data/partitioned-index-regional/results/read-b/<region>.json
.bench-data/partitioned-index-regional/results/write-a/<region>.json
.bench-data/partitioned-index-regional/results/write-b/<region>.json
.bench-data/partitioned-index-regional/results/contention-a/<region>.json
.bench-data/partitioned-index-regional/results/contention-b/<region>.json
```

Aggregate with:

```powershell
npm run benchmark:partitioned-index:regional:aggregate
```

The default artifact is:

```text
evidence/partitioned-index-regional-worker-2026-09-26.json
```

No production Worker, bucket, route, domain, package export, or main-branch
storage protocol is used or changed by this experiment.
