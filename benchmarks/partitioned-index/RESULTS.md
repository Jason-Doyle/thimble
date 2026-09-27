# Value-routed secondary-index partition experiment

Date: 27 September 2026

Branch: `experiment/value-routed-index-partitions`

Tested main commit:

```text
b0471ad20e05bd07b4a42f15bc1fc0d152fa1735
```

Tested implementation and regional harness commit:

```text
ddc1f6bd6fb8c7427cba46bd36c9a070e85cd8b2
```

## Decision

The experiment is positive.

Value-routed partitions are the first secondary-index partition design tested
in this repository that improved both selective reads and indexed writes.

Compared with the current monolithic index pages, the candidate:

- kept covered equality and range queries at two browser requests
- reduced covered index transfer by 73-74%
- improved covered-query p50 by 33-41%
- improved covered-query p95 by 33-45%
- improved Snapshot single-writer p50 by 15% and p95 by 34%
- improved Trie single-writer p50 by 4% and p95 by 15%
- improved contended p50 by about 40%
- improved contended p95 by 28-34%
- added only 1.3-1.6% stored bytes

The useful conclusion is:

> Partitioning by queryable values can reduce index write amplification
> without exposing shard fan-out to covered queries.

The branch should continue to production-design work. It should not merge
into `main` in its current form because range boundaries are static, skew and
rebalancing are unresolved, and globally contended writes remain far outside
interactive latency targets.

## Candidate design

Each configured index uses four immutable partitions.

Equality index:

```text
hash(canonical indexed value tuple) -> one partition
```

Range index:

```text
(-infinity, 6250)
[6250, 12500)
[12500, 18750)
[18750, +infinity)
```

The collection HEAD atomically contains:

- the index definition
- routing strategy
- range boundaries or hash partition count
- immutable partition hashes
- per-partition entry, document, and decoded-byte counts
- aggregate entry count

Queries:

- equality selects one hash partition
- equality on a range field selects one ordered partition
- lower and upper range comparisons select only intersecting partitions
- the existing index evaluator rechecks the complete predicate

Mutations:

- a covering-field update within one route rewrites one partition
- an indexed value that moves routes rewrites the old and new partitions
- document layout objects and index references remain one atomic HEAD
  publication

The benchmark update changed `lastModified` from its original quartile to a
value above 25,000. It therefore exercised a real old-partition to
new-partition move rather than an optimistic same-route update.

## Range planning correction

The experiment also corrected range index planning to retain both lower and
upper comparisons on the indexed field.

The current planner selects the first matching range comparison and then
applies the remaining predicate after candidate selection. The matched
25-document range previously scanned 7,500 index candidates.

Both baseline and candidate in this experiment used the corrected planner and
scanned 25 candidates. The candidate comparison therefore isolates partition
size and routing rather than claiming the planner correction as a partition
benefit.

## Scope

The candidate remains isolated:

- no production Worker change
- no public configuration option
- no package export
- no migration
- no release protocol
- no custom domain
- no change to `thimbledb.com`

## Workload and regions

The regional benchmark used:

- 25,000 encrypted JSON documents
- Snapshot and Trie layouts
- one equality index covering `title` and `lastModified`
- one range index covering `title` and `category`
- four routed partitions per index
- seven Azure caller regions
- two independent replicates
- 1,736 measured operations

Regions and observed Cloudflare colos:

| Azure region | Cloudflare colo |
| --- | --- |
| East US | IAD |
| West US 2 | SEA |
| North Europe | DUB |
| Southeast Asia | SIN |
| Japan East | NRT |
| Australia East | SYD |
| Brazil South | GRU |

Browser query planning, HTTPS reads, TDB1 decoding, predicate evaluation, and
result validation ran in the regional Node callers. Writes ran inside the
temporary Cloudflare Worker against R2.

Read fixtures were immutable. Single-writer regions used separate prefixes.
Single-writer replicates ran sequentially. Every write and contention
replicate used a recreated empty bucket so content-addressed objects from an
earlier run could not be reused.

Only the final pinned runs are retained in the evidence. Smoke tests and
methodologically invalid preliminary runs were discarded.

## Stored representation

| Layout | Baseline objects | Candidate objects | Baseline bytes | Candidate bytes | Byte change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 4 | 10 | 1,171,510 | 1,190,046 | +1.58% |
| Trie | 276 | 282 | 1,416,813 | 1,435,347 | +1.31% |

Each index adds up to three objects relative to the monolithic page. Metadata
and independent envelope overhead account for the additional stored bytes.

## Covered equality

The query matched 125 documents and returned 25 covering projections.

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 744.57 ms | 502.29 ms | 32.54% faster | 1,489.95 ms | 814.80 ms | 45.31% faster |
| Trie | 760.66 ms | 499.65 ms | 34.31% faster | 1,096.50 ms | 735.91 ms | 32.89% faster |

Both baseline and candidate used two browser reads:

```text
HEAD + one index object
```

Mean transferred bytes:

| Layout | Baseline | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Snapshot | 326,397 | 87,267 | 73.26% |
| Trie | 326,370 | 87,238 | 73.27% |

Candidate p50 improved in all seven regions. The smallest Snapshot gain was
19.55% in Southeast Asia; the largest was 49.53% in West US 2.

## Covered range

The query matched 25 documents and selected one ordered partition.

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 951.40 ms | 561.45 ms | 40.99% faster | 1,488.40 ms | 815.30 ms | 45.22% faster |
| Trie | 923.23 ms | 542.16 ms | 41.28% faster | 1,329.22 ms | 858.37 ms | 35.42% faster |

Both paths used two browser reads and scanned 25 candidates.

Mean transferred bytes fell from about 397 KiB to 101 KiB, a 74.49%
reduction. Candidate Trie p50 improved in every region by 29.31-57.56%.

## Uncovered equality

The index selected 125 IDs and the caller loaded complete documents.

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 17,329.79 ms | 16,995.81 ms | 1.93% faster | 28,266.31 ms | 26,394.49 ms | 6.62% faster |
| Trie | 1,979.03 ms | 1,875.75 ms | 5.22% faster | 6,926.19 ms | 6,742.59 ms | 2.65% faster |

The routed index reduced transfer by 30.87% for Snapshot and 39.69% for Trie,
but document materialisation dominated the operation.

Two baseline Trie samples returned caller `fetch failed` errors. All routed
uncovered queries succeeded. The failures remain in the raw evidence and are
excluded from successful latency percentiles.

## Warm re-query

The warm case cached the selected equality partition, removed cached HEAD and
that one partition, then repeated the query.

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 770.09 ms | 508.44 ms | 33.98% faster | 1,139.56 ms | 757.24 ms | 33.55% faster |
| Trie | 762.24 ms | 512.57 ms | 32.75% faster | 1,116.67 ms | 786.03 ms | 29.61% faster |

The candidate retained two reads and transferred 73% fewer bytes.

## Single-writer updates

Every regional single-writer fixture was isolated. Both replicates began in a
new empty R2 bucket. All 448 operations succeeded with zero CAS retries and
zero immutable-object reuse.

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 7,438.66 ms | 6,311.56 ms | 15.15% faster | 15,250.56 ms | 10,129.41 ms | 33.58% faster |
| Trie | 7,850.36 ms | 7,550.93 ms | 3.81% faster | 12,887.07 ms | 10,967.05 ms | 14.90% faster |

Object operations and bytes:

| Layout | Baseline reads | Candidate reads | Baseline writes | Candidate writes | Read-byte change | Write-byte change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 4 | 5 | 4 | 5 | 37.25% fewer | 37.25% fewer |
| Trie | 8 | 7 | 6 | 7 | 79.94% fewer | 59.99% fewer |

Snapshot pays one additional read and write because the range value moves
between partitions. Trie saves one read because it no longer loads two
monolithic index pages, but it still writes one additional partition object.

The byte reduction outweighed the added operation in the pooled latency
result.

## Simultaneous multi-region writes

Seven regions started three iterations against one shared generation in each
of two pristine-bucket replicates.

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 16,603.37 ms | 10,032.29 ms | 39.58% faster | 82,963.38 ms | 59,918.65 ms | 27.78% faster |
| Trie | 16,510.84 ms | 9,910.67 ms | 39.97% faster | 76,567.98 ms | 50,837.21 ms | 33.61% faster |

All 168 operations succeeded.

Contention bytes:

| Layout | Read-byte change | Write-byte change | CAS retry change |
| --- | ---: | ---: | ---: |
| Snapshot | 46.43% fewer | 49.19% fewer | 2.738 to 2.190 |
| Trie | 84.25% fewer | 72.70% fewer | 2.643 to 1.857 |

The candidate reduced the conflict window enough to improve latency and retry
counts. Absolute p95 remained 51-60 seconds. Neither layout is suitable for
interactive globally contended writes.

## Local preflight

The local in-memory object-store run isolated codec and rewrite work:

| Layout | Baseline p50 | Candidate p50 | Baseline written bytes | Candidate written bytes |
| --- | ---: | ---: | ---: | ---: |
| Snapshot | 1,301.33 ms | 299.21 ms | 1,171,618 | 735,000 |
| Trie | 474.60 ms | 112.46 ms | 727,638 | 291,021 |

Local timing excludes object-storage latency and is secondary to regional
evidence.

## Acceptance result

| Requirement | Result |
| --- | --- |
| Keep routed equality at two browser reads | Passed |
| Keep narrow routed range at two browser reads | Passed |
| Reduce covered index transfer by at least 50% | Passed, 73-74% |
| Avoid pooled covered-read regression | Passed, improved 33-45% |
| Improve indexed-value-move write bytes | Passed |
| Improve single-writer latency | Passed |
| Preserve atomic document and index publication | Passed |
| Preserve covering projections and query correctness | Passed |
| Improve contention latency and retries | Passed |
| Keep stored-byte overhead below 3% | Passed |
| Make globally contended writes interactive | Failed |
| Support automatic range-boundary rebalancing | Not implemented |
| Prove resilience to highly skewed equality values | Not measured |
| Define a compatible migration and rollback protocol | Not implemented |

## Recommendation

Continue this design toward a production-shaped protocol. Do not merge the
experimental implementation directly.

The next design phase should address:

1. automatic split, merge, and boundary publication for range partitions
2. skew detection and hot-value handling for equality partitions
3. a compatible metadata version and migration from monolithic index pages
4. garbage collection for retired partition objects
5. Studio inspection and rebuild behavior
6. configuration bounds and operator guidance
7. rollback to monolithic pages without data loss

The routing strategy should remain per-index:

- hash-value routing for exact equality indexes
- ordered boundaries for range indexes
- monolithic pages for small or highly skewed indexes

Promotion should require a skew and rebalance experiment. Static boundaries
are not a safe production default for arbitrary application data.

## Raw evidence

Repository artifacts:

```text
evidence/value-routed-index-regional-worker-2026-09-27.json
SHA-256 67E7BC38A9B8886C6F776CB98E248577CE28951C96B6EB5B912C16230272DD99

evidence/value-routed-index-local-2026-09-27.json
SHA-256 C602BEF6314C9664622E732B1B7526CE0692B48C004D7BE3A53E0847AF822CF6
```

The regional artifact contains:

- all 1,736 measured operations
- two replicates across seven regions
- complete raw samples
- caller end-to-end latency
- object read and write counts
- read and written bytes
- CAS retry counts
- pooled and per-region summaries
- both retained baseline transport failures

## Cleanup verification

Cleanup completed and was verified:

```text
temporary workers.dev Worker: deleted, endpoint returns 404
temporary R2 bucket: deleted
temporary Azure resource group: deleted
```

No production resource was used or changed by this evaluation.
