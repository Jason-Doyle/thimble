# Production write-scaling evaluation

Date: 27 September 2026

Branch: `experiment/write-scaling`

Tested production commit:

```text
b0471ad20e05bd07b4a42f15bc1fc0d152fa1735
```

Tested benchmark commit:

```text
87a8874f5e36370957dca1f360c7520e7a2dc52a
```

## Decision

The multi-second write problem exists across the current production write
path. It is not limited to the 25,000-document benchmark or to one
experimental index design.

The strongest findings are:

- small no-index Snapshot writes were 2.10 seconds p50
- small no-index Trie writes were 4.13 seconds p50
- Trie no-index p50 stayed near four seconds from 128 to 25,000 documents
- each additional index added object round trips and substantial latency
- 25,000 documents with two indexes reached 8.09 seconds Snapshot p50 and
  8.59 seconds Trie p50
- every one of the 1,008 regional writes succeeded with no CAS retries

This means there are two distinct costs:

1. a fixed serial object-operation cost, visible even for 128 documents
2. payload and index-maintenance cost, which grows with collection and index
   size

The useful conclusion is:

> Reducing payload size alone will not make writes interactive. The write path
> must also remove or overlap authority-to-object-store round trips.

## Matrix

The regional benchmark used:

- Snapshot and Trie production engines from unchanged `main`
- 128, 5,000, and 25,000 document collections
- zero, one, and two covering secondary indexes
- one document update per measured operation
- four iterations per case and region
- seven Azure regions
- two independent replicates
- recreated empty R2 buckets between replicates
- isolated prefixes for every region and case
- 1,008 measured writes

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

Authentication and rendering were excluded. The regional caller timed one
complete protected Worker request. The Worker recorded R2 operation count,
bytes, and duration grouped by object type.

## Pooled one-document latency

### Snapshot

| Documents | Indexes | p50 | p95 | Reads | Writes | Read bytes | Written bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 0 | 2,100 ms | 3,026 ms | 2 | 2 | 2,849 | 2,866 |
| 128 | 1 | 3,037 ms | 4,400 ms | 3 | 3 | 4,940 | 4,958 |
| 128 | 2 | 4,267 ms | 6,005 ms | 4 | 4 | 7,324 | 7,344 |
| 5,000 | 0 | 2,273 ms | 3,178 ms | 2 | 2 | 88,016 | 88,113 |
| 5,000 | 1 | 3,397 ms | 4,597 ms | 3 | 3 | 153,935 | 154,035 |
| 5,000 | 2 | 4,484 ms | 6,366 ms | 4 | 4 | 234,118 | 234,228 |
| 25,000 | 0 | 2,718 ms | 4,479 ms | 2 | 2 | 448,436 | 448,534 |
| 25,000 | 1 | 5,872 ms | 8,852 ms | 3 | 3 | 774,574 | 774,673 |
| 25,000 | 2 | 8,088 ms | 11,373 ms | 4 | 4 | 1,171,641 | 1,171,751 |

### Trie

| Documents | Indexes | p50 | p95 | Reads | Writes | Read bytes | Written bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 0 | 4,127 ms | 6,012 ms | 4 | 4 | 1,600 | 1,622 |
| 128 | 1 | 5,373 ms | 7,531 ms | 6 | 5 | 5,740 | 3,741 |
| 128 | 2 | 6,567 ms | 9,678 ms | 8 | 6 | 10,445 | 6,128 |
| 5,000 | 0 | 4,072 ms | 5,690 ms | 4 | 4 | 2,596 | 2,618 |
| 5,000 | 1 | 5,532 ms | 7,472 ms | 6 | 5 | 134,394 | 68,571 |
| 5,000 | 2 | 6,963 ms | 9,935 ms | 8 | 6 | 294,699 | 148,765 |
| 25,000 | 0 | 4,140 ms | 5,737 ms | 4 | 4 | 4,447 | 4,475 |
| 25,000 | 1 | 6,300 ms | 8,879 ms | 6 | 5 | 656,671 | 330,639 |
| 25,000 | 2 | 8,593 ms | 11,549 ms | 8 | 6 | 1,450,744 | 727,720 |

## Where the latency cliff begins

At pooled p50:

- every current case exceeded two seconds
- every Trie case exceeded four seconds
- two indexes pushed the 128-document Snapshot above four seconds
- one index pushed the 128-document Trie above five seconds
- 25,000 documents with one index pushed both layouts above five seconds
- 25,000 documents with two indexes pushed both layouts above eight seconds

This is not a single large-collection threshold. The fixed object-operation
path is already too slow for an interactive write at small scale.

## Fixed operation cost

No-index writes isolate the document layout from index maintenance.

Snapshot p50:

```text
128 documents      2.10 s
5,000 documents    2.27 s
25,000 documents   2.72 s
```

Trie p50:

```text
128 documents      4.13 s
5,000 documents    4.07 s
25,000 documents   4.14 s
```

Trie latency is nearly flat even though stored path bytes grow. It performs
four serial reads and four serial writes:

```text
HEAD
root
branch
leaf
```

Snapshot performs two reads and two writes:

```text
HEAD
snapshot
```

The near-flat Trie curve shows that serial request count is more important
than collection size for no-index writes.

## Index cost

### Snapshot

Index count increases both request count and payload.

Relative to no indexes:

| Documents | One-index p50 change | Two-index p50 change |
| ---: | ---: | ---: |
| 128 | +44.61% | +103.12% |
| 5,000 | +49.45% | +97.27% |
| 25,000 | +116.06% | +197.61% |

At 25,000 documents, the two index objects add 723 KiB to both reads and
writes, in addition to the 448 KiB snapshot.

### Trie

The current Trie path reads each configured index twice:

1. index-configuration validation
2. index update preparation

It then writes one replacement object per index.

Relative to no indexes:

| Documents | One-index p50 change | Two-index p50 change |
| ---: | ---: | ---: |
| 128 | +30.21% | +59.13% |
| 5,000 | +35.85% | +70.99% |
| 25,000 | +52.18% | +107.58% |

At 25,000 documents with two indexes:

- four index reads transferred 1.45 MiB
- two index writes transferred 723 KiB
- the three-document Trie node path transferred about 4 KiB

The nominally small Trie update is dominated by monolithic index pages.

## R2 stage evidence

Cloudflare Worker `performance.now()` is an I/O-oriented timer in production.
The durations below describe awaited R2 operations, not complete CPU time.

Mean R2 time for selected cases:

| Case | Read duration | Write duration | End-to-end mean |
| --- | ---: | ---: | ---: |
| Small no-index Snapshot | 754 ms | 1,207 ms | 1,980 ms |
| Small no-index Trie | 1,495 ms | 2,317 ms | 3,831 ms |
| Large no-index Snapshot | 837 ms | 1,780 ms | 2,789 ms |
| Large no-index Trie | 1,474 ms | 2,281 ms | 3,773 ms |
| Large two-index Snapshot | 1,967 ms | 6,006 ms | 8,197 ms |
| Large two-index Trie | 3,896 ms | 4,099 ms | 8,060 ms |

Awaited object-store operations account for most observed end-to-end time.
Local CPU evidence still grows with index size:

| Case | Local p50 |
| --- | ---: |
| Large no-index Snapshot | 178 ms |
| Large one-index Snapshot | 990 ms |
| Large two-index Snapshot | 1,241 ms |
| Large no-index Trie | 1.8 ms |
| Large one-index Trie | 203 ms |
| Large two-index Trie | 470 ms |

The two measurements are complementary:

- R2 round trips dominate cloud wall time.
- index preparation is the main local CPU scaling cost.

## Regional spread

Selected p50 values:

| Region | Small no-index Snapshot | Small no-index Trie | Large two-index Snapshot | Large two-index Trie |
| --- | ---: | ---: | ---: | ---: |
| East US | 898 ms | 1,798 ms | 4,669 ms | 4,369 ms |
| West US 2 | 968 ms | 1,826 ms | 7,663 ms | 5,356 ms |
| North Europe | 1,876 ms | 3,803 ms | 6,635 ms | 7,118 ms |
| Southeast Asia | 2,945 ms | 5,866 ms | 9,455 ms | 10,859 ms |
| Japan East | 2,361 ms | 4,149 ms | 7,845 ms | 8,593 ms |
| Australia East | 2,196 ms | 4,410 ms | 8,261 ms | 9,214 ms |
| Brazil South | 2,155 ms | 4,253 ms | 8,847 ms | 9,282 ms |

The nearest measured regions can approach one second for a small Snapshot
write, but the same operation is about three seconds from Southeast Asia.
Multi-region latency is therefore a product boundary even at 128 documents.

## Implications for browser compute

The data supports a browser-assisted write experiment, but not arbitrary
client-generated object publication.

The browser can safely contribute:

- cached current HEAD and immutable object values
- the intended document mutation
- a bounded batch of ordinary mutations
- optimistic local UI state

The authority can validate supplied context:

- recompute content hashes
- verify the root, branch, leaf, or index chain against the supplied HEAD
- publish with the supplied HEAD ETag using `If-Match`
- fall back to authoritative R2 reads on missing context or CAS conflict

For a warm Trie client, verified client context could remove:

- the HEAD read
- three Trie node reads
- duplicate index reads

At 25,000 documents with two indexes, current Trie reads consumed 3.90 seconds
of measured R2 time. This is the strongest browser-assistance opportunity.

For Snapshot, sending the current snapshot and two index pages back to the
authority would upload roughly 1.17 MiB and still require authoritative
validation. Mutation batching is likely a better fit than echoing the whole
Snapshot state.

## Recommended experiments

### 1. Remove duplicate Trie index reads

Reuse the pages loaded during index-configuration validation when preparing
the update. This can reduce two-index Trie reads from eight to six without a
protocol change.

### 2. Warm client-assisted Trie write context

For a browser with cached Trie path and index pages:

1. send the ordinary mutation, cached HEAD value and ETag, and referenced
   decoded objects
2. recompute and verify every object hash and reference in the authority
3. prepare and upload changed immutable objects
4. publish HEAD with `If-Match`
5. fall back to the current path on missing cache context or conflict

Compare payload, validation CPU, latency, and conflict behavior.

### 3. Bounded mutation batching

Batch sizes 1, 5, and 20 should measure:

- total batch latency
- amortized latency per document
- object count and bytes per document
- conflict rate
- read-your-writes behavior

Batching is useful for autosave, imports, generated content, and bursty local
edits. It does not improve a single isolated mutation unless the UI can wait
for a short coalescing window.

### 4. Retain bounded parallel immutable commits

The separate parallel-write experiment improved current large two-index
writes by about 20% without changing the protocol. It is a useful component,
but not a complete solution.

## Positioning consequence

Current ThimbleDB writes are not suitable for latency-sensitive interactive
actions over broad geography.

The current credible boundary is:

- warm reads dominate
- writes are infrequent, background, or locally optimistic
- small Snapshot writes may approach one second near the Worker and R2 path
- remote Trie writes or indexed writes require explicit tolerance for
  multi-second completion

This should remain the public performance position until a production change
is merged and remeasured.

## Raw evidence

Repository artifacts:

```text
evidence/write-scaling-regional-worker-2026-09-27.json
SHA-256 FB922BE12A86631482FC4EA52C21F8D29FD211F42E3C7C45765CC23E157FB0A3

evidence/write-scaling-local-2026-09-27.json
SHA-256 23B461C033F5BD16CC17AA199FA526D790898EDD4A289CE30FCE6427D4BB017D
```

The regional artifact contains all 1,008 raw writes, R2 stage metrics, both
replicates, seven regions, pooled summaries, and per-region summaries.

## Cleanup verification

Cleanup completed and was verified:

```text
temporary workers.dev Worker: deleted, endpoint returns 404
temporary R2 bucket: deleted
temporary Azure resource group: deleted
```

No production resource was used or changed by this evaluation.
