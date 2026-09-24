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

## Example decision from measured R2 results

A multi-region run used trie for a 128-product catalogue. Cold reads required
four sequential broker requests and took 2.55-4.84 seconds from the tested
regions. Switching `products` and `customers` to snapshots reduced product
cold-read time by 29-53 percent. With a 10-second HEAD TTL, warm product-read
p95 was 1.6-8.3 ms.

For a similar small, mostly idle catalogue, start with snapshot. Measure before
using the same choice for a write-heavy or much larger collection.
