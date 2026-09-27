# Parallel write-pipeline experiment

Date: 27 September 2026

Branch: `experiment/parallel-write-pipeline`

Tested implementation and harness commit:

```text
c7db0b0d5bc4592f77c4d631d7549deee8b9d3a9
```

## Decision

Bounded parallelism is safe and useful, but it is not enough to solve
ThimbleDB's large indexed-write latency.

The candidate preserved the exact current object keys, decoded object bytes,
HEAD shape, read request counts, write operation counts, transferred bytes,
and conditional publication protocol.

Regional large two-index writes improved:

- Snapshot p50: 19.79%
- Snapshot p95: 15.19%
- Trie p50: 21.16%
- Trie p95: 18.58%

Absolute candidate latency remained:

- Snapshot: 5.67 seconds p50, 10.13 seconds p95
- Trie: 6.49 seconds p50, 8.96 seconds p95

The experiment therefore failed its primary goal of bringing the large
two-index p50 below four seconds with at least a 30% improvement.

The useful conclusion is:

> Serial object-store work is a meaningful part of write latency, but the
> remaining cost is too large for scheduling changes alone.

## Candidate design

The public write API and durability semantics did not change.

Every write still:

1. reads the current collection state
2. validates and prepares document and index changes
3. writes every required immutable object
4. waits for all immutable writes to succeed
5. publishes HEAD last with conditional `If-Match`
6. returns success only after HEAD publication

The candidate changes only step 3:

- Snapshot and index object uploads overlap.
- Trie node writes and index uploads overlap.
- Independent index object uploads use a maximum concurrency of three.
- Index validation completes before candidate uploads begin.

It does not return `202 Accepted`, defer durability, use a queue, or trust a
client-generated database state.

## Protocol equivalence

Automated tests wrote the same mutations through sequential and parallel
Snapshot and Trie engines.

Verified:

- identical stored object keys
- identical decoded object bytes
- identical collection HEAD values
- identical query and scan results
- identical object read and write counts
- identical transferred bytes
- HEAD remains the final publication operation
- oversized index validation still fails before document-layout objects are
  written

The regional post-write checks also used the current browser client and
confirmed:

| Layout | Path | Sequential reads | Parallel reads | Byte change |
| --- | --- | ---: | ---: | ---: |
| Snapshot | Point | 2 | 2 | -0.02% |
| Snapshot | Covered range | 1 | 1 | 0% |
| Trie | Point | 4 | 4 | -0.21% |
| Trie | Covered range | 1 | 1 | 0% |

The byte differences are envelope-level variation measured after independent
writes. The logical object keys and decoded values are identical.

Only 14 post-write read samples existed per case. Their p95 values were noisy,
including regressions for Trie, so they are not used as evidence of a read
latency improvement. The deterministic protocol-equivalence tests are the
reason this candidate is considered read-neutral.

## Regional method

The regional benchmark used:

- the current 25,000-document workload
- Snapshot and Trie layouts
- two covering secondary indexes
- current sequential and bounded-parallel variants
- six one-document updates per case
- seven Azure regions
- two independent replicates
- recreated empty R2 buckets between replicates
- isolated region and variant prefixes
- 336 measured writes
- 56 post-write browser-client read checks

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

All 336 writes and all 56 read checks succeeded. No write used a CAS retry.

## Regional write result

| Layout | Sequential p50 | Parallel p50 | Change | Sequential p95 | Parallel p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snapshot | 7,071.24 ms | 5,672.04 ms | 19.79% faster | 11,940.00 ms | 10,126.03 ms | 15.19% faster |
| Trie | 8,235.88 ms | 6,492.81 ms | 21.16% faster | 11,005.72 ms | 8,960.49 ms | 18.58% faster |

Every candidate p50 improved by region:

- Snapshot: 9.34-25.36%
- Trie: 17.82-26.13%

Snapshot p95 regressed by 13.13% in North Europe. Trie p95 was effectively
flat in North Europe and improved in the other six regions.

## Object operations

Scheduling changed, but work volume did not:

| Layout | Variant | Reads | Read bytes | Writes | Written bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| Snapshot | Sequential | 4 | 1,171,784 | 4 | 1,171,907 |
| Snapshot | Parallel | 4 | 1,171,746 | 4 | 1,171,853 |
| Trie | Sequential | 8 | 1,450,808 | 6 | 727,778 |
| Trie | Parallel | 8 | 1,450,809 | 6 | 727,768 |

Maximum simultaneous operations:

| Layout | Sequential reads/writes | Parallel reads/writes |
| --- | ---: | ---: |
| Snapshot | 1 / 1 | 1 / 3 |
| Trie | 1 / 1 | 2 / 3 |

The experiment reduces elapsed time by overlapping existing work. It does not
reduce storage cost or write amplification.

## Regional stage evidence

Cloudflare Worker timers are I/O-oriented and do not advance normally during
CPU-only work. They are useful for locating awaited object-store stages, not
for calculating complete CPU time.

Mean stage duration:

| Layout | Stage | Sequential | Parallel | Interpretation |
| --- | --- | ---: | ---: | --- |
| Snapshot | Load current state | 1,869 ms | 1,889 ms | Unchanged |
| Snapshot | Immutable upload pipeline | 4,680 ms | 3,048 ms | 34.9% shorter |
| Snapshot | HEAD publication | 657 ms | 816 ms | No improvement |
| Snapshot | Worker I/O timer total | 7,206 ms | 5,754 ms | 20.2% shorter |
| Trie | Load current HEAD | 1,311 ms | 1,318 ms | Unchanged |
| Trie | Index preparation I/O | 691 ms | 449 ms | Two index reads overlap |
| Trie | Tree pipeline | 3,577 ms | 3,634 ms | Unchanged dependent path |
| Trie | Immutable pipeline | 5,026 ms | 3,659 ms | 27.2% shorter |
| Trie | HEAD publication | 633 ms | 600 ms | Effectively unchanged |
| Trie | Worker I/O timer total | 7,661 ms | 6,025 ms | 21.3% shorter |

Snapshot is still dominated by loading current state and uploading the
snapshot plus index pages. Trie is still dominated by the dependent
leaf-to-branch-to-root write path.

## Local size and index-count matrix

The local benchmark used an in-memory object store with 8 ms fixed latency per
operation.

Parallel p50 change:

| Profile | Indexes | Snapshot | Trie |
| --- | ---: | ---: | ---: |
| 128 documents | 0 | -20.55% | -0.40% |
| 128 documents | 1 | -18.94% | -9.21% |
| 128 documents | 2 | -33.07% | -21.41% |
| 5,000 documents | 0 | -0.40% | +0.23% |
| 5,000 documents | 1 | -16.47% | -7.42% |
| 5,000 documents | 2 | -11.65% | -15.87% |
| 25,000 documents | 0 | +0.71% | -0.68% |
| 25,000 documents | 1 | -7.76% | -15.45% |
| 25,000 documents | 2 | -4.44% | -14.09% |

Negative values are improvements.

The gain grows with independent index work, not document count alone.
Zero-index large writes were effectively unchanged.

## Browser-compute assessment

The experiment does not support moving database object construction into the
browser as a simple next step.

Potentially useful browser work:

- coalescing several user mutations into one bounded batch
- optimistic local UI with an explicit pending state
- calculating ordinary mutation values and validation hints

Work that must remain authoritative unless the trust model changes:

- loading and validating current HEAD
- verifying current immutable object hashes
- deriving authoritative index state
- publishing all immutable objects
- conditional HEAD commit
- conflict retry and failure reporting

A browser can construct candidate snapshot, Trie, or index objects because it
holds the data key. That does not make those objects trustworthy. The
authority would still need to validate them against current HEAD and the
requested mutation, which retains much of the expensive work while adding a
large browser-to-authority upload.

The safer browser-assisted experiment is mutation batching. The browser can
send several ordinary document changes in one authenticated request, while
the authority performs one state load, one index update, one immutable commit,
and one HEAD publication. This improves amortized cost without trusting
client-generated database structures.

## Acceptance result

| Requirement | Result |
| --- | --- |
| Preserve exact read protocol and object references | Passed |
| Preserve browser read counts and bytes | Passed |
| Preserve atomic HEAD-last publication | Passed |
| Preserve validation before immutable writes | Passed |
| Keep operation counts and bytes unchanged | Passed |
| Avoid new failures or CAS retries | Passed |
| Improve pooled regional p50 and p95 | Passed |
| Improve every regional p50 | Passed |
| Improve every regional p95 | Failed |
| Improve large two-index p50 by at least 30% | Failed |
| Bring large two-index p50 below four seconds | Failed |

## Recommendation

Do not merge bounded parallelism as the complete write-latency solution.

It is a low-risk optimisation worth retaining, but it leaves the critical path
too slow. The next experiment should combine:

1. bounded parallel immutable commits
2. a browser-facing bounded batch mutation endpoint
3. one authoritative state load and HEAD publication per batch
4. stage and per-document latency for batch sizes 1, 5, and 20

That experiment keeps read behavior unchanged and uses the browser as a
mutation coordinator rather than trusting it to generate database state.

If batching cannot reduce interactive batch completion and amortized
per-document cost enough, further progress requires changing write
amplification, such as the parked value-routed index design.

## Raw evidence

Repository artifacts:

```text
evidence/parallel-write-regional-worker-2026-09-27.json
SHA-256 917C7D5F7F0556E62D5E9EA02B7687FD8AD71099424CF2802E11803EF2932F27

evidence/parallel-write-local-2026-09-27.json
SHA-256 FE2D0BD9001B2A2F5554A321AB2F80E489546569C72435640CEBFB5B4F01B884
```

The regional artifact contains all raw write samples, stage timers,
post-write read checks, pooled summaries, and per-region summaries.

## Cleanup verification

Cleanup completed and was verified:

```text
temporary workers.dev Worker: deleted, endpoint returns 404
temporary R2 bucket: deleted
temporary Azure resource group: deleted
```

No production resource was used or changed by this evaluation.
