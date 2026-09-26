# Partitioned secondary-index experiment

Date: 26 September 2026

Branch: `experiment/partitioned-secondary-indexes`

Tested implementation commit:

```text
796f217db9baa2d645f1ea256e1a7f779523e3bf
```

## Decision

The experiment supports continuing the partitioned-index direction, but it
does not support merging the current eight-shard design into `main`.

The candidate materially reduced indexed-write bytes, latency, retries, and
contention failures. It also made cold indexed queries slower because every
query had to retrieve and merge eight immutable shards.

The useful conclusion is:

> Partitioning secondary indexes is a credible way to reduce write
> amplification. A production design must avoid exposing the complete shard
> fan-out to every cold browser query.

## Design

Each declared index uses eight immutable shards selected by a deterministic
hash of the document ID.

The collection HEAD contains:

- the index definition
- partition count
- each immutable shard hash
- per-shard entry, document, and decoded-byte counts
- aggregate index entry count

A document mutation:

1. reads the collection HEAD
2. reads the current document path
3. identifies one index shard from the document ID
4. rewrites that shard for each configured index
5. writes changed document-layout objects
6. publishes one replacement collection HEAD with `If-Match`
7. retries from the latest HEAD after a conflict

The HEAD remains the transaction boundary for document and index references.
Readers see one complete generation.

## Scope

The candidate is isolated:

- no published package
- no public configuration option
- no change to `main`
- no production deployment
- no change to `thimbledb.com`

The experiment changes the branch's internal HEAD shape. It is not a proposed
compatible release protocol.

## Workload

The regional benchmark used:

- 25,000 encrypted JSON documents
- Snapshot and Trie layouts
- one equality index covering `title` and `lastModified`
- one range index covering `title` and `category`
- eight index shards
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

All browser-client query planning, HTTPS object reads, TDB1 decoding, index
merging, predicate evaluation, and result validation ran in the Azure callers.
All writes ran inside the temporary Cloudflare Worker against R2.

## Stored representation

| Layout | Baseline objects | Candidate objects | Baseline bytes | Candidate bytes |
| --- | ---: | ---: | ---: | ---: |
| Snapshot | 4 | 18 | 1,171,510 | 1,224,932 |
| Trie | 276 | 290 | 1,416,813 | 1,470,233 |

Eight partitions increased stored bytes by about 4.6 percent for Snapshot and
3.8 percent for Trie. Each of two indexes added seven objects relative to the
single-page baseline.

## Cold indexed reads

### Covered equality

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 766.48 ms | 927.54 ms | 21.01% slower | 1,108.49 ms | 1,448.88 ms | 30.71% slower |
| Trie | 764.37 ms | 940.15 ms | 23.00% slower | 1,029.28 ms | 1,361.40 ms | 32.27% slower |

Baseline used two network reads. The candidate used nine: HEAD plus eight
index shards.

### Covered range

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 1,007.60 ms | 1,171.72 ms | 16.29% slower | 1,446.99 ms | 1,804.88 ms | 24.73% slower |
| Trie | 966.23 ms | 1,202.36 ms | 24.44% slower | 1,484.09 ms | 1,916.12 ms | 29.11% slower |

### Uncovered equality

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 18,027.82 ms | 17,434.06 ms | 3.29% faster | 27,300.56 ms | 27,833.79 ms | 1.95% slower |
| Trie | 1,877.89 ms | 2,055.27 ms | 9.45% slower | 6,722.92 ms | 6,896.10 ms | 2.58% slower |

One baseline Trie and one partitioned Trie sample failed with caller transport
errors. Both remain in the raw evidence and are excluded from successful
latency percentiles.

## Warm re-query

The warm case loaded all shards, removed cached HEAD plus one index object,
then repeated the covered equality query.

| Layout | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 | Baseline bytes | Candidate bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 741.14 ms | 813.90 ms | 1,150.12 ms | 1,200.28 ms | 326,397 | 45,672 |
| Trie | 745.84 ms | 808.32 ms | 1,112.08 ms | 1,198.05 ms | 326,370 | 45,643 |

The candidate reduced transfer by 86.01 percent while keeping two network
reads. It was still 4-10 percent slower because the client parsed and merged
all cached shard pages.

This result proves a bandwidth benefit. It does not prove a latency benefit
for the current browser merge implementation.

## Single-writer results

| Layout | Baseline p50 | Candidate p50 | Change | Baseline p95 | Candidate p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 7,330.22 ms | 4,845.93 ms | 33.89% faster | 9,964.52 ms | 7,059.15 ms | 29.16% faster |
| Trie | 7,951.01 ms | 6,393.99 ms | 19.58% faster | 11,302.70 ms | 8,592.15 ms | 23.98% faster |

| Layout | Baseline read bytes | Candidate read bytes | Change | Baseline written bytes | Candidate written bytes | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 1,172,054 | 546,783 | 53.35% fewer | 1,172,217 | 546,941 | 53.34% fewer |
| Trie | 1,450,847 | 102,477 | 92.94% fewer | 727,823 | 102,545 | 85.91% fewer |

All 448 single-writer operations succeeded. Candidate p50 improved in every
region for both layouts. Candidate Snapshot p95 regressed by 34.44 percent in
North Europe; every other candidate p95 improved.

Absolute write latency remains too high for latency-sensitive request paths.

## Simultaneous multi-region writes

Seven regions started writes against one shared generation for each layout and
variant.

| Layout | Baseline success | Candidate success | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 38/42, 90.48% | 42/42, 100% | 9,599.48 ms | 6,647.30 ms | 68,328.10 ms | 34,926.38 ms |
| Trie | 42/42, 100% | 42/42, 100% | 16,787.88 ms | 9,083.54 ms | 101,734.80 ms | 33,734.51 ms |

Candidate changes:

- Snapshot p50: 30.75 percent faster
- Snapshot p95: 48.88 percent faster
- Trie p50: 45.89 percent faster
- Trie p95: 66.84 percent faster
- Snapshot written bytes: 61.83 percent fewer
- Trie written bytes: 95.91 percent fewer

Four baseline Snapshot operations returned Cloudflare 503 responses after long
requests. Every partitioned operation completed successfully.

The candidate improved contention substantially. A 34-second p95 is still not
acceptable for interactive globally shared writes.

## Local preflight

The local in-memory object-store preflight isolated codec and rewrite work:

| Layout | Baseline p50 | Candidate p50 | Baseline bytes written | Candidate bytes written |
| --- | ---: | ---: | ---: | ---: |
| Snapshot | 1,291.70 ms | 225.97 ms | 1,171,618 | 546,372 |
| Trie | 472.81 ms | 40.39 ms | 727,638 | 102,390 |

These local timings exclude network latency and are secondary to the regional
evidence.

## Acceptance result

| Requirement | Result |
| --- | --- |
| Materially reduce indexed-write amplification | Passed |
| Improve single-writer regional latency | Passed overall |
| Avoid additional write operations | Passed |
| Preserve atomic document and index publication | Passed |
| Preserve query correctness and covering projections | Passed |
| Avoid cold-read regression | Failed |
| Improve warm re-query latency | Failed |
| Reduce warm re-query transfer | Passed |
| Make globally contended writes production-safe | Failed |

## Recommendation

Continue the partitioned-index research, but do not merge the current design.

The next experiment should preserve its write protocol while removing browser
fan-out. Two credible options are:

1. an authority-side bounded index bundle that fetches shards in parallel and
   returns one validated index value
2. value-routed partitions that let equality queries select one shard and
   ranges select only intersecting shards

Test four partitions as well as eight. Four partitions may retain enough write
reduction while reducing cold request fan-out and merge work.

Do not add this layout to public configuration, migration, or package types
until one query strategy demonstrates a latency result close to the
monolithic baseline.

## Raw evidence

Repository artifacts:

```text
evidence/partitioned-index-regional-worker-2026-09-26.json
SHA-256 235DAB75F0D50627ED2903B1B8FF3F24CDACD59E8E29FA987D3DB49D9066189C

evidence/partitioned-index-local-2026-09-26.json
SHA-256 0661065FDF4176B77E35C82D9187330C46E43E660933D37080E8FF8238C7A3E7
```

Temporary Worker, R2, Azure, and local staging resources were removed after
evidence capture.
