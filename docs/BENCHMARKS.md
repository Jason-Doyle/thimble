# R2 browser benchmarks

This page reports live browser measurements against the Cloudflare Worker and
R2 reference deployment. Results describe the tested workload and regions;
they do not imply general superiority over another database.

## Workload

Each regional browser run:

- opens the production Worker custom domain
- exchanges a real Entra access token
- reads one cold product from a 128-product catalogue
- performs 100 sequential product reads
- scans a 32-customer collection
- clears browser caches before each cold operation

## Multi-region result

Raw artifacts:

```text
evidence/r2-browser-multiregion-trie-2026-09-24.json
evidence/r2-browser-multiregion-snapshot-2026-09-24.json
```

Disposable Chromium 153 containers ran in North Europe, US East, and Southeast
Asia against a private Worker custom domain, private R2 buckets, and Entra
session exchange.

Initial run, product trie, customer snapshot, one-second HEAD TTL:

| Region | Auth | Cold product | Hot p50 | Hot p95 | Customer scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| North Europe | 8,068.2 ms | 4,149.0 ms | 0.3 ms | 1,908.6 ms | 1,959.2 ms |
| US East | 5,348.6 ms | 2,550.0 ms | 0.3 ms | 1,319.0 ms | 1,250.4 ms |
| Southeast Asia | 16,137.3 ms | 4,844.9 ms | 1,216.0 ms | 2,559.9 ms | 3,122.4 ms |

The four sequential trie object requests missed the cold-read threshold. In
Southeast Asia, one round trip exceeded the one-second HEAD TTL, so every hot
read revalidated HEAD.

Reference configuration after the first run: product and customer snapshots
with a ten-second HEAD TTL.

| Region | Auth | Cold product | Hot p50 | Hot p95 | Customer scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| North Europe | 8,619.9 ms | 1,933.9 ms | 0.9 ms | 8.3 ms | 1,713.8 ms |
| US East | 4,933.4 ms | 1,247.0 ms | 0.8 ms | 5.2 ms | 949.2 ms |
| Southeast Asia | 12,717.9 ms | 3,439.6 ms | 0.7 ms | 1.6 ms | 3,006.9 ms |

## What the results mean

- Snapshot layout reduced product cold-read time by 29-53 percent.
- The ten-second HEAD TTL removed repeated regional revalidation from the
  100-read loop.
- Warm in-memory reads were sub-millisecond at p50 in all three regions.
- Cold reads and external session creation remain well above the published
  latency targets.
- Cloud-region probes approximate geography but do not represent residential
  last-mile networks.
- The result supports adaptive layout selection for this workload. It does not
  establish superiority over another database.

## Measurements not covered

The published runs do not cover:

- first load, warm memory, warm IndexedDB, and offline reads
- gzip ratio and CPU cost by object-size bucket
- AES-GCM and device-cache encryption cost
- key-grant latency
- Worker CPU time and subrequest counts
- R2 Class A and Class B operations per user action
- contention after partitioning or sharding collection roots
- cost at idle and at representative small-app traffic

## Layout decision thresholds

Choose trie as the sole storage model only when measurements show:

- at least 5x fewer transferred bytes than a cached snapshot for point reads
- warm IndexedDB reads within 2x of plain IndexedDB JSON
- encrypted first-read p95 below 250 ms from the reference Cloudflare region
- fewer than two conditional-write retries at p95 for normal small-app traffic
- maintenance below 10 percent of write operations

The live R2 run missed the cold-read threshold, so the reference deployment
uses an adaptive layout:

- compressed immutable snapshot for small collections
- sharded pages only when measured size or access patterns justify them
