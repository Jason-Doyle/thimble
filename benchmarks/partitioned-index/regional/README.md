# Value-routed secondary-index regional experiment

This harness compares current monolithic secondary-index pages with an
experimental four-partition layout on the isolated
`experiment/value-routed-index-partitions` branch.

The candidate keeps collection HEAD publication atomic:

```text
collection HEAD
  index reference
    routing strategy and partition count
    immutable shard hashes and decoded sizes
```

Equality index values map deterministically to one hash partition. Range
indexes use three explicit ordered boundaries. Equality queries read one
partition and bounded ranges read only intersecting partitions.

A covering-field update within one route rewrites one partition. An indexed
value that moves routes rewrites the old and new partitions. Collection HEAD
remains the atomic publication boundary.

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

The warm re-query case preloads the routed equality partition, removes cached
HEAD and that partition, then repeats the query. It measures the expected
fetch after one routed partition changes without mutating the shared read
fixture.

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
evidence/value-routed-index-regional-worker-2026-09-27.json
```

No production Worker, bucket, route, domain, package export, or main-branch
storage protocol is used or changed by this experiment.
