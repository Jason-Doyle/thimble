# Post-merge write-scaling benchmark

Date: 28 September 2026

Branch: `benchmark/post-merge-write-scaling`

Production source commit:

```text
2c648a603d21f69872839272b560a547abb13a9b
```

Regional harness commit:

```text
33cfe72cfeef885ff5cfbb618b2dd24687ba8bca
```

Historical baseline source commit:

```text
b0471ad20e05bd07b4a42f15bc1fc0d152fa1735
```

## Decision

The merged bounded write scheduler reduced the additional p50 cost of two
indexes by 48 to 72 percent, depending on layout and collection size. It did
not make writes interactive.

The current pooled p50 floor was:

- 2.98 to 3.40 seconds for Snapshot without indexes
- 5.29 to 5.41 seconds for Trie without indexes
- 6.82 seconds for a 25,000-document Snapshot with two indexes
- 8.28 seconds for a 25,000-document Trie with two indexes

The run retained three R2 internal failures. All three affected the
128-document no-index Snapshot case in one replicate. There were no CAS
retries.

Absolute latency was higher than the historical 27 September run even for
no-index paths that received no meaningful scheduling benefit. Current
no-index R2 read duration was 15 to 53 percent higher, and write duration was
34 to 63 percent higher. The cross-day absolute difference therefore cannot
be assigned to the code change.

The useful conclusion is:

> Parallel immutable commits materially reduce index amplification, but fixed
> object-store latency still defines a multi-second write floor.

The next write experiment should test authoritative mutation batches of 1, 5,
and 20 documents.

## Method

The regional matrix covered:

- Snapshot and Trie production engines
- 128, 5,000, and 25,000 documents
- zero, one, and two covering secondary indexes
- one document update per measured request
- four iterations per case and region
- seven Azure caller regions
- two pristine-bucket replicates
- 1,008 measured writes

Every region and case used an isolated object prefix. Replicates used separate
empty R2 buckets. The authority ran in a temporary Cloudflare Worker.

Azure Container Instances pulled a Microsoft-hosted base image. Each caller
downloaded the official Node 22.23.2 Linux binary, verified SHA-256
`d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`,
and then ran the bundled benchmark client. This retained the same Node version
as the historical evidence without relying on anonymous Docker Hub pulls.

Authentication, browser rendering, and residential last-mile latency were
excluded.

## Current pooled latency

![Post-merge write p50](https://thimbledb.com/benchmarks/write-scaling-p50.svg)

| Documents | Indexes | Snapshot p50 | Snapshot p95 | Trie p50 | Trie p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 0 | 2,978.32 ms | 4,505.01 ms | 5,368.26 ms | 8,351.43 ms |
| 128 | 1 | 3,204.00 ms | 5,091.59 ms | 6,174.99 ms | 9,647.55 ms |
| 128 | 2 | 3,823.22 ms | 6,161.79 ms | 6,662.93 ms | 10,443.30 ms |
| 5,000 | 0 | 2,989.05 ms | 5,242.72 ms | 5,409.68 ms | 9,037.61 ms |
| 5,000 | 1 | 3,326.31 ms | 5,572.12 ms | 6,231.32 ms | 10,327.19 ms |
| 5,000 | 2 | 4,180.63 ms | 7,494.76 ms | 6,917.44 ms | 10,634.01 ms |
| 25,000 | 0 | 3,397.36 ms | 5,317.22 ms | 5,291.72 ms | 8,486.50 ms |
| 25,000 | 1 | 5,538.96 ms | 9,553.94 ms | 6,882.60 ms | 11,607.23 ms |
| 25,000 | 2 | 6,824.25 ms | 13,563.15 ms | 8,278.35 ms | 13,070.55 ms |

No tested case reached an interactive sub-second write target.

## Reliability

| Result | Count |
| --- | ---: |
| Successful writes | 1,005 |
| Failed writes | 3 |
| Success rate | 99.70% |
| Mean CAS retries | 0 |

The three failures were:

```text
put: We encountered an internal error. Please try again. (10001)
```

They occurred in East US, West US 2, and North Europe during the first
replicate. Each failed request ran for about 16 to 17 seconds. The second
replicate completed all 504 writes successfully.

Failures remain in the raw evidence and are excluded from successful-operation
percentiles.

## Index amplification

The table compares the two-index p50 increase relative to the no-index case in
the same run. This normalization reduces the effect of different R2 conditions
between days.

| Documents | Layout | Historical increase | Post-merge increase | Relative reduction |
| ---: | --- | ---: | ---: | ---: |
| 128 | Snapshot | +103.12% | +28.37% | 72.49% |
| 128 | Trie | +59.13% | +24.12% | 59.21% |
| 5,000 | Snapshot | +97.27% | +39.86% | 59.02% |
| 5,000 | Trie | +70.99% | +27.87% | 60.74% |
| 25,000 | Snapshot | +197.61% | +100.87% | 48.96% |
| 25,000 | Trie | +107.58% | +56.44% | 47.54% |

For 25,000 documents, the incremental p50 cost of moving from zero to two
indexes changed from:

- 5,370 ms to 3,427 ms for Snapshot, 36.19 percent lower
- 4,453 ms to 2,987 ms for Trie, 32.94 percent lower

Operation counts and transferred bytes remained unchanged.

## Local CPU comparison

The current and historical commits were rerun on the same machine with eight
iterations per case.

| Case | Historical p50 | Post-merge p50 | Change |
| --- | ---: | ---: | ---: |
| Large no-index Snapshot | 169.59 ms | 167.59 ms | -1.18% |
| Large one-index Snapshot | 996.45 ms | 983.06 ms | -1.34% |
| Large two-index Snapshot | 1,245.92 ms | 1,237.37 ms | -0.69% |
| Large no-index Trie | 2.01 ms | 1.75 ms | -13.08% |
| Large one-index Trie | 201.47 ms | 204.25 ms | +1.38% |
| Large two-index Trie | 468.49 ms | 458.96 ms | -2.03% |

The scheduling change did not create a material local CPU regression.

## Object-store time

Cloudflare Worker `performance.now()` records awaited I/O. Read and write
durations below are sums across operations. Parallel writes can therefore
produce a summed duration greater than wall time.

| Case | Mean read duration | Mean write duration | End-to-end mean |
| --- | ---: | ---: | ---: |
| Small no-index Snapshot | 944 ms | 1,967 ms | 2,938 ms |
| Small no-index Trie | 1,713 ms | 3,507 ms | 5,247 ms |
| Large no-index Snapshot | 1,282 ms | 2,385 ms | 3,777 ms |
| Large no-index Trie | 1,722 ms | 3,614 ms | 5,361 ms |
| Large two-index Snapshot | 2,469 ms | 12,722 ms | 8,116 ms |
| Large two-index Trie | 4,638 ms | 7,318 ms | 8,655 ms |

The no-index paths show the current fixed object-store floor. The indexed
paths show why summed per-object duration must not be treated as serial wall
time after bounded parallel commits.

## Regional spread

The table pools two replicates per region.

| Region | Small no-index Snapshot | Small no-index Trie | Large two-index Snapshot | Large two-index Trie |
| --- | ---: | ---: | ---: | ---: |
| East US | 2,300.60 ms | 3,119.37 ms | 6,482.19 ms | 6,779.64 ms |
| West US 2 | 1,451.93 ms | 2,635.70 ms | 5,065.96 ms | 4,957.34 ms |
| North Europe | 3,032.37 ms | 5,684.71 ms | 6,817.33 ms | 8,907.43 ms |
| Southeast Asia | 3,799.29 ms | 7,803.29 ms | 10,504.38 ms | 12,292.35 ms |
| Japan East | 2,839.17 ms | 5,487.63 ms | 6,647.97 ms | 7,697.63 ms |
| Australia East | 2,978.32 ms | 4,663.99 ms | 6,694.15 ms | 8,278.35 ms |
| Brazil South | 3,517.65 ms | 6,183.90 ms | 8,398.24 ms | 9,177.92 ms |

Geography remains a product boundary. The same small no-index Snapshot write
was about 1.45 seconds in West US 2 and 3.80 seconds in Southeast Asia.

## Scaling limits

### Fixed request floor

Snapshot still performs two reads and two writes without indexes. Trie still
performs four reads and four dependent writes. Bounded parallel index uploads
cannot remove those operations.

### Global index pages

Every configured index remains one collection-wide immutable page. The
scheduler overlaps independent uploads, but page encoding, encryption,
transfer, and replacement still scale with the index.

At 25,000 documents with two indexes:

- Snapshot read and wrote about 1.17 MiB
- Trie read about 1.45 MiB and wrote about 728 KiB

### One mutable collection HEAD

This matrix used isolated single writers and recorded no CAS retries. It does
not change the earlier finding that globally contended writes to one HEAD are
a poor fit.

### User guidance

Users should:

- partition by user, tenant, workspace, or another independent ownership key
- keep writes out of latency-critical request paths
- debounce frequent edits rather than writing every keystroke
- declare only indexes that support measured queries
- use covering projections for bounded list and card views
- choose Snapshot for small, scan-heavy, low-write collections
- choose Trie for selective keyed access when lower transfer volume justifies
  more requests
- use another database for hot shared state, global counters, or interactive
  multi-region writes

## Historical comparison limits

The historical and current regional runs used the same deterministic data,
matrix, Node version, regions, operation order, and R2 account. They ran on
different days and reached different Cloudflare colos in several regions.

Absolute cross-day latency changes are descriptive, not causal. The evidence
supports these narrower claims:

- operation counts and bytes did not change
- local CPU remained effectively neutral
- two-index amplification relative to the same run's no-index floor decreased
- current absolute write limits remain multi-second

## Raw evidence

Post-merge regional evidence:

```text
evidence/write-scaling-regional-worker-2026-09-28.json
SHA-256 A433E2729528787929FCAED89448FBBCE3ED51977DEC6D8B95C06BC40BAD09DD
```

Post-merge local evidence:

```text
evidence/write-scaling-local-2026-09-28.json
SHA-256 C3273165AEA82CDE6B0EB052D174BFEDD3D7CAA8E7BC04329FC9C9D891924D63
```

Historical regional baseline:

```text
evidence/write-scaling-regional-worker-2026-09-27.json
SHA-256 FB922BE12A86631482FC4EA52C21F8D29FD211F42E3C7C45765CC23E157FB0A3
```

Historical local baseline:

```text
evidence/write-scaling-local-2026-09-27.json
SHA-256 23B461C033F5BD16CC17AA199FA526D790898EDD4A289CE30FCE6427D4BB017D
```

Same-machine historical local rerun:

```text
evidence/write-scaling-local-baseline-rerun-2026-09-28.json
SHA-256 B474B2017A0F275C0EB819B03EFA0DED469E09C82BCCBB8811788CBC183B063A
```

Comparison CSV:

```text
evidence/write-scaling-comparison-2026-09-28.csv
```

The temporary Worker, R2 buckets, and Azure resource groups were deleted
after evidence capture. No production resource was changed.
