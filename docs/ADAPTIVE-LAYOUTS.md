# Adaptive collection layouts

ThimbleDB supports two browser-readable immutable layouts.

| Layout | Cold point read | Full scan | Write amplification | Best fit |
| --- | --- | --- | --- | --- |
| Content-addressed trie | HEAD, root, branch, leaf | Every reachable branch and leaf | Rewrites one leaf, branch, root, and HEAD | Larger point-read-heavy collections or concurrent writers |
| Immutable snapshot | HEAD and one snapshot | HEAD and one snapshot | Rewrites the compressed collection snapshot and HEAD | Small, mostly idle, scan-heavy collections |

## Advisory selection

Selection is advisory, never automatic in v1:

```powershell
$env:THIMBLE_DOCUMENT_COUNT = "128"
$env:THIMBLE_AVERAGE_DOCUMENT_BYTES = "900"
$env:THIMBLE_POINT_READ_RATIO = "0.6"
$env:THIMBLE_SCAN_RATIO = "0.3"
$env:THIMBLE_WRITES_PER_MINUTE = "0.2"
$env:THIMBLE_CONCURRENT_WRITERS = "1"
npm run advise:layout
```

The advisor returns a layout, confidence, estimated collection bytes, and the
threshold reasons. It does not change data or configuration.

The initial thresholds prefer snapshots when:

- estimated payload is at most 256 KiB
- writes are at most one per minute
- there is at most one concurrent writer
- scans are at least 35 percent of reads

They prefer tries when:

- estimated payload is at least 512 KiB
- writes are at least five per minute
- there are at least two concurrent writers
- point reads are at least 70 percent of reads

Ambiguous evidence remains low confidence and defaults to trie.

## Explicit layout configuration

```text
THIMBLE_COLLECTION_LAYOUTS=products=snapshot,customers=snapshot
```

Collections not listed use trie.

## Migration

Layout migration requires a write freeze:

1. Set `THIMBLE_MAINTENANCE_MODE=true` on every authority.
2. Confirm writes return `503 maintenance_mode`.
3. Ensure the collection has no retained tombstones.
4. Run `npm run migrate:layout`, or call the administrator migration endpoint.
5. Verify full document equality in the target layout.
6. Add the new layout to `THIMBLE_COLLECTION_LAYOUTS`.
7. Record the previous layout in `THIMBLE_RETIRED_COLLECTION_LAYOUTS`.
8. Increment or otherwise change the deployed layout generation by changing
   the layout configuration.
9. Disable maintenance mode.

The source layout remains available for rollback until quiescent retention
maintenance drops its entire retired prefix. Open browser clients periodically
check the layout generation and reload before they can read or mutate through
a retired layout.

## Decisions from measured R2 results

Current seven-region evidence covers 128, 5,000, and 25,000-document
collections with two declared secondary indexes.

- Snapshot cold point-read p95 was 37-50 percent lower than direct trie p95
  across all three sizes.
- Trie point reads transferred 95-99 percent fewer bytes at medium and large
  sizes, but required four sequential requests.
- A trie read bundle reduced medium and large trie p95 by 9 and 17 percent,
  respectively. It increased small-profile p95.
- Snapshot scans were 72-85 percent faster at p95.
- At 25,000 documents, an uncovered equality query was much faster through
  Trie than Snapshot, despite 117 network reads.
- With two indexes, single-writer snapshot latency was lower than trie latency
  in this run, although Snapshot wrote more than twice as many bytes.
- Simultaneous seven-region writes produced failures and very high tail
  latency for both layouts.

These results strengthen snapshot as the default for small and scan-heavy
collections. They also show why document count alone is not enough to choose a
layout. Query coverage, request count, decoded snapshot size, write bytes, and
writer geography all matter.

The earlier authenticated Chromium run remains useful for browser cache and
session measurements. See [Cloud benchmark evidence](BENCHMARKS.md) for both
methods and their limitations.
