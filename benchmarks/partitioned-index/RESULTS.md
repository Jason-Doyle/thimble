# Four-shard secondary-index and authority-bundle experiment

Date: 27 September 2026

Branch: `experiment/partitioned-index-bundle`

Tested implementation commit:

```text
d47acfa1318ba7adc3669a2b9b68c9377fc75b23
```

## Decision

Keep the branch and evidence, but do not merge this design into `main`.

Four index shards retained meaningful write improvements and reduced the
storage overhead of the earlier eight-shard experiment. They did not remove
the cold-read regression.

The authority bundle reduced caller requests from five to one for a
partitioned index query. It still performed five R2 reads and added authority
validation, JSON assembly, compression, transport, decompression, and caller
validation. The resulting covered queries were slower than both the current
monolithic direct path and the four-shard direct path.

The useful conclusion is:

> Fixed ID-sharded secondary indexes remain a credible write-amplification
> technique, but neither four-way browser fan-out nor the tested authority
> bundle provides an acceptable read path. The design should remain an
> experiment.

## Candidate design

Each declared secondary index uses four immutable shards selected by a
deterministic hash of the document ID.

The collection HEAD contains:

- the index definition
- partition count
- each immutable shard hash
- per-shard entry, document, and decoded-byte counts
- aggregate index entry count

A document mutation rewrites one shard for each affected index, writes the
changed document-layout objects, and publishes one replacement collection
HEAD with `If-Match`.

The experimental authority bundle:

1. reads and decodes collection HEAD
2. validates the selected index definition and bounded source sizes
3. reads one monolithic page or four partition pages in parallel
4. validates every page against HEAD metadata
5. returns one gzip-compressed `no-store` response
6. requires the caller to validate HEAD, revision, object metadata, shard
   definitions, and decoded sizes before query evaluation

The endpoint was protected by a benchmark token and existed only in the
temporary Worker.

## Scope

The candidate remains isolated:

- no published package export
- no public configuration option
- no production storage protocol
- no change to `main`
- no production route or custom domain
- no change to `thimbledb.com`

## Workload

The regional benchmark used:

- 25,000 encrypted JSON documents
- Snapshot and Trie layouts
- one equality index covering `title` and `lastModified`
- one range index covering `title` and `category`
- four index shards
- seven Azure caller regions
- two independent replicates
- 2,296 measured operations

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

Browser query planning, HTTPS reads, TDB1 decoding, index merging, predicate
evaluation, and result validation ran in the Azure callers for direct cases.
Bundle source reads and validation ran inside the temporary Cloudflare Worker.
All writes ran inside that Worker against the temporary R2 bucket.

The primary latency is caller-observed `clientElapsedMs` around the complete
operation.

## Stored representation

| Layout | Baseline objects | Four-shard objects | Baseline bytes | Four-shard bytes | Byte change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 4 | 10 | 1,171,510 | 1,200,355 | +2.46% |
| Trie | 276 | 282 | 1,416,813 | 1,445,654 | +2.04% |

Four shards add three objects per index relative to the monolithic page. The
earlier eight-shard design added seven objects per index and about 3.8-4.6%
stored bytes.

## Direct cold indexed reads

### Covered equality

| Layout | Baseline p50 | Four-shard p50 | Change | Baseline p95 | Four-shard p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 834.79 ms | 1,030.29 ms | 23.42% slower | 1,403.40 ms | 1,750.19 ms | 24.71% slower |
| Trie | 785.79 ms | 986.08 ms | 25.49% slower | 1,193.64 ms | 1,574.35 ms | 31.89% slower |

The baseline used two caller reads. The candidate used five: HEAD plus four
index shards.

### Covered range

| Layout | Baseline p50 | Four-shard p50 | Change | Baseline p95 | Four-shard p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 1,035.55 ms | 1,284.10 ms | 24.00% slower | 1,845.35 ms | 2,289.53 ms | 24.07% slower |
| Trie | 1,031.41 ms | 1,345.27 ms | 30.43% slower | 1,752.03 ms | 2,036.93 ms | 16.26% slower |

### Uncovered equality

| Layout | Baseline p50 | Four-shard p50 | Change | Baseline p95 | Four-shard p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 18,818.52 ms | 19,514.67 ms | 3.70% slower | 29,218.13 ms | 29,991.77 ms | 2.65% slower |
| Trie | 2,039.69 ms | 2,194.29 ms | 7.58% slower | 6,807.75 ms | 7,843.70 ms | 15.22% slower |

Four shards did not produce a cold-read latency improvement in any measured
query class.

## Warm re-query

The warm case preloaded all index objects, removed cached HEAD and one index
object, then repeated the covered equality query.

| Layout | Baseline p50 | Four-shard p50 | Change | Baseline p95 | Four-shard p95 | Change | Byte change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 793.74 ms | 879.88 ms | 10.85% slower | 1,260.02 ms | 1,435.25 ms | 13.91% slower | 74.05% fewer |
| Trie | 803.62 ms | 883.97 ms | 10.00% slower | 1,233.36 ms | 1,361.30 ms | 10.37% slower | 74.06% fewer |

The changed shard reduced transferred bytes from about 326 KiB to 85 KiB.
Parsing and merging the cached pages still made the candidate slower.

## Authority bundle result

The table compares direct monolithic baseline reads, direct four-shard reads,
and four-shard bundle reads.

### Caller-observed p50

| Query | Layout | Direct baseline | Direct four-shard | Four-shard bundle | Bundle change vs baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| Covered equality | Snapshot | 834.79 ms | 1,030.29 ms | 1,107.25 ms | 32.64% slower |
| Covered equality | Trie | 785.79 ms | 986.08 ms | 1,109.80 ms | 41.23% slower |
| Covered range | Snapshot | 1,035.55 ms | 1,284.10 ms | 1,451.76 ms | 40.19% slower |
| Covered range | Trie | 1,031.41 ms | 1,345.27 ms | 1,469.46 ms | 42.47% slower |

### Caller-observed p95

| Query | Layout | Direct baseline | Direct four-shard | Four-shard bundle | Bundle change vs baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| Covered equality | Snapshot | 1,403.40 ms | 1,750.19 ms | 1,912.61 ms | 36.28% slower |
| Covered equality | Trie | 1,193.64 ms | 1,574.35 ms | 1,747.55 ms | 46.40% slower |
| Covered range | Snapshot | 1,845.35 ms | 2,289.53 ms | 2,234.46 ms | 21.09% slower |
| Covered range | Trie | 1,752.03 ms | 2,036.93 ms | 2,307.82 ms | 31.72% slower |

The bundle used one caller request instead of five, an 80% reduction. It
still used five R2 reads. Its compressed response was 0.37-1.26% larger than
the direct four-shard stored bytes because it included bundle metadata.

The bundle was also slower than direct four-shard reads:

- equality p50: 7.47-12.55% slower
- equality p95: 9.28-11.00% slower
- range p50: 9.23-13.06% slower
- range p95: 2.41% faster for Snapshot and 13.30% slower for Trie

The same endpoint bundled the monolithic baseline as a control. Even that
control was 23.14-28.70% slower at p50 than direct monolithic equality reads
and 25.44-26.35% slower for ranges. The bundle overhead is therefore not only
a consequence of partitioning.

## Single-writer results

| Layout | Baseline p50 | Four-shard p50 | Change | Baseline p95 | Four-shard p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 10,291.77 ms | 8,165.63 ms | 20.66% faster | 18,550.52 ms | 11,981.57 ms | 35.41% faster |
| Trie | 12,423.86 ms | 10,292.56 ms | 17.15% faster | 19,826.88 ms | 15,630.49 ms | 21.17% faster |

| Layout | Read-byte change | Write-byte change | Storage-operation change |
| --- | ---: | ---: | ---: |
| Snapshot | 45.62% fewer | 45.62% fewer | unchanged |
| Trie | 86.70% fewer | 73.47% fewer | reads 25% fewer, writes unchanged |

All 448 single-writer operations succeeded. The candidate retained the
write-amplification benefit, but absolute p50 remained 8.2-10.3 seconds.

## Simultaneous multi-region writes

Seven regions started writes against one shared generation for each layout
and variant.

| Layout | Baseline success | Four-shard success | Baseline p50 | Four-shard p50 | Baseline p95 | Four-shard p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 39/42, 92.86% | 42/42, 100% | 16,909.17 ms | 9,070.84 ms | 83,623.93 ms | 48,767.91 ms |
| Trie | 42/42, 100% | 42/42, 100% | 19,831.52 ms | 13,298.91 ms | 119,766.84 ms | 50,045.17 ms |

Candidate changes:

- Snapshot p50: 46.36% faster
- Snapshot p95: 41.68% faster
- Trie p50: 32.94% faster
- Trie p95: 58.21% faster
- Snapshot written bytes: 58.76% fewer
- Trie written bytes: 91.09% fewer

Three baseline Snapshot operations returned Cloudflare 503 responses after
long requests. The failures remain in the raw evidence. Every four-shard
operation completed successfully.

A 49-50 second candidate p95 remains unsuitable for interactive globally
contended writes.

## Local preflight

The pinned local in-memory object-store preflight isolated codec and rewrite
work:

| Layout | Baseline p50 | Four-shard p50 | Baseline written bytes | Four-shard written bytes |
| --- | ---: | ---: | ---: | ---: |
| Snapshot | 1,288.17 ms | 269.55 ms | 1,171,618 | 636,898 |
| Trie | 479.92 ms | 74.66 ms | 727,638 | 192,917 |

These local timings exclude network latency and are secondary to the regional
evidence.

## Acceptance result

| Requirement | Result |
| --- | --- |
| Materially reduce indexed-write amplification | Passed |
| Improve single-writer regional latency | Passed overall |
| Improve measured contention latency and success | Passed |
| Preserve atomic document and index publication | Passed |
| Preserve query correctness and covering projections | Passed |
| Reduce four-shard storage overhead relative to eight shards | Passed |
| Avoid direct cold-read regression | Failed |
| Improve warm re-query latency | Failed |
| Reduce warm re-query transfer | Passed |
| Reduce partitioned caller request fan-out with a bundle | Passed |
| Match or beat direct monolithic read latency with a bundle | Failed |
| Match or beat direct four-shard latency with a bundle | Failed |
| Make globally contended writes production-safe | Failed |

## Recommendation

Do not add fixed ID-sharded secondary indexes or this authority bundle to
public configuration, migrations, package exports, or the main storage
protocol.

The experiment confirms a real tradeoff rather than a feature:

- writes move less data and complete sooner
- reads require more objects
- browser-side merging is slower
- authority-side bundling removes caller fan-out but adds more latency
- global write contention remains far beyond an interactive target

Retain this branch as implementation and benchmark evidence. Continue with
the separately planned authorization-gated immutable-object edge-cache
experiment against unchanged `main`. That experiment tests a different
question: whether provider read placement is a material part of current cold
read latency without changing the storage format.

## Raw evidence

Repository artifacts:

```text
evidence/four-shard-index-bundle-regional-worker-2026-09-26.json
SHA-256 91177E4204171F4C7CD067D5FD400CDABC08AC2B3A915B34CE808265EA55FFD0

evidence/four-shard-index-bundle-local-2026-09-26.json
SHA-256 1CDDD43313449328A7C6A9C03D0930EC44FFCB352538C6E6391F5251E93B293D
```

The regional artifact contains:

- all 2,296 raw samples
- both replicates
- all seven regions
- Cloudflare colo values
- caller end-to-end latency
- caller and R2 read counts
- caller and R2 byte counts
- pooled summaries
- per-region summaries
- comparison percentages
- retained failures

## Cleanup verification

Cleanup completed and was verified:

```text
temporary workers.dev Worker: deleted, endpoint returns 404
temporary R2 objects: 8,220 deleted
temporary R2 bucket: deleted
temporary Azure resource group: deleted
```

No production resource was used or changed by this evaluation.
