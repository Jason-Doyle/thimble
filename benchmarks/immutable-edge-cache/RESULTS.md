# Authorization-gated immutable-object edge-cache experiment

Date: 27 September 2026

Branch: `experiment/immutable-edge-cache`

Tested main commit:

```text
623a253349d2b9ee6cbf5fbc25b2391d1627366e
```

Tested harness commit:

```text
10b6486797a291649dc0703c6e2333abcd29039b
```

## Decision

The experiment supports continuing this design as a narrow, opt-in
Cloudflare authority feature.

It does not support merging the benchmark implementation directly into
`main`, enabling it by default, or presenting it as a general cache solution.

The strongest result is the large Trie point path:

- direct point p50 improved by 70.99%
- direct point p95 improved by 71.95%
- bundled point p50 improved by 72.13%
- bundled point p95 improved by 72.37%
- the result improved at p50 and p95 in all seven regions

The cache did not reduce browser request count or transferred bytes. It
removed R2 reads for immutable objects after a colo-local cache warm-up. The
mutable collection HEAD continued to reach R2 on every cold-client operation.

The useful conclusion is:

> R2 object placement is a material part of current cold-client latency.
> Caching encrypted immutable objects after authorization can substantially
> improve point and selective-read latency without changing ThimbleDB's
> storage protocol.

This remains a best-case cache-hit result. Real hit rates for small,
low-traffic, per-user applications are not yet known.

## Candidate design

The experiment adds an `ObjectStore` wrapper used only by the temporary
Cloudflare Worker.

For every request:

1. the Worker validates the benchmark authorization token
2. the object key is checked against a strict immutable-key allowlist
3. collection `HEAD.json` bypasses cache and reads R2
4. content-addressed snapshots, Trie nodes, and index pages use
   `caches.default`
5. a miss reads the original encrypted TDB1 bytes from R2
6. the encrypted bytes and ETag are stored in the local Cloudflare colo cache
7. the caller receives the same private, non-cacheable object response
8. the browser decrypts, validates, and processes the object normally

The cache key includes:

- an experiment namespace
- the backing storage namespace
- the complete scoped object key

Missing objects are not cached. Writes and deletes evict the corresponding
immutable key in the experimental wrapper.

The cache entry TTL was one hour. Cloudflare documents that Cache API entries
do not replicate outside the originating data centre and that `cache.put`
does not use tiered caching:

```text
https://developers.cloudflare.com/workers/runtime-apis/cache/
```

## Security boundary

Authorization occurs before every baseline or edge-cache lookup.

Each of the 14 regional runs tested three unauthorised requests:

| Probe | Expected | Result |
| --- | ---: | ---: |
| Benchmark configuration containing the test key | 403 | 14/14 returned 403 |
| Ordinary encrypted object | 403 | 14/14 returned 403 |
| Object already present in the edge cache | 403 | 14/14 returned 403 |

The cached bytes remained encrypted TDB1 envelopes. The cache did not contain
decrypted documents, sessions, grants, authentication records, collection
HEAD objects, or bundle responses.

This proves the benchmark route ordering and object allowlist. It does not
replace a production review of session revocation, scope deletion, key
rotation, cache expiry, and cache purge behaviour.

## Scope

The candidate remains isolated:

- no production Worker change
- no public configuration option
- no package export
- no storage protocol change
- no migration
- no custom domain
- no change to `thimbledb.com`

## Workload

The regional benchmark used:

- the unchanged current Snapshot and Trie layouts
- 128, 5,000, and 25,000 document profiles
- encrypted TDB1 objects
- current point-read and point-bundle paths
- covered equality and range queries
- uncovered equality queries
- complete scans
- seven Azure caller regions
- two independent replicates
- 5,544 measured operations

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

Every measured operation used a new browser-client instance with an empty
memory and persistent cache.

Three edge states were compared:

| State | Behaviour |
| --- | --- |
| Baseline | Every object read used the authorization gate and R2 |
| Edge cold | A unique cache namespace forced immutable-object misses |
| Edge warm | Required immutable objects were confirmed present in the serving colo before measurement |

Operation order rotated within each profile. Warm-up and cache-prime
operations were excluded from measured samples.

## Point reads

### Direct point reads

| Profile | Layout | Baseline p50 | Edge-warm p50 | Change | Baseline p95 | Edge-warm p95 | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | Snapshot | 368.12 ms | 199.10 ms | 45.91% faster | 646.13 ms | 333.78 ms | 48.34% faster |
| Small | Trie | 743.40 ms | 230.90 ms | 68.94% faster | 1,291.20 ms | 398.08 ms | 69.17% faster |
| Medium | Snapshot | 409.26 ms | 245.81 ms | 39.94% faster | 639.83 ms | 381.22 ms | 40.42% faster |
| Medium | Trie | 753.41 ms | 236.86 ms | 68.56% faster | 1,201.95 ms | 376.29 ms | 68.69% faster |
| Large | Snapshot | 625.36 ms | 455.24 ms | 27.20% faster | 882.52 ms | 626.30 ms | 29.03% faster |
| Large | Trie | 745.13 ms | 216.14 ms | 70.99% faster | 1,268.53 ms | 355.88 ms | 71.95% faster |

### Point-read bundles

| Profile | Layout | Baseline p50 | Edge-warm p50 | Change | Baseline p95 | Edge-warm p95 | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | Snapshot | 361.70 ms | 194.42 ms | 46.25% faster | 627.60 ms | 336.02 ms | 46.46% faster |
| Small | Trie | 699.49 ms | 193.91 ms | 72.28% faster | 1,217.93 ms | 357.24 ms | 70.67% faster |
| Medium | Snapshot | 502.76 ms | 349.69 ms | 30.45% faster | 782.45 ms | 531.50 ms | 32.07% faster |
| Medium | Trie | 727.40 ms | 197.63 ms | 72.83% faster | 1,153.20 ms | 322.91 ms | 72.00% faster |
| Large | Snapshot fallback | 812.67 ms | 657.90 ms | 19.04% faster | 1,206.49 ms | 972.04 ms | 19.43% faster |
| Large | Trie | 699.32 ms | 194.90 ms | 72.13% faster | 1,206.49 ms | 333.39 ms | 72.37% faster |

The large Snapshot bundle remained above its decoded response bound and
correctly fell back to direct object reads. Its edge result saved one R2 read
but did not make the bundle itself viable for large snapshots.

## Large point-read consistency by region

### Direct Trie point

| Region | p50 change | p95 change |
| --- | ---: | ---: |
| East US | 61.53% faster | 61.21% faster |
| West US 2 | 62.54% faster | 61.55% faster |
| North Europe | 71.64% faster | 74.81% faster |
| Southeast Asia | 71.57% faster | 70.50% faster |
| Japan East | 68.01% faster | 66.85% faster |
| Australia East | 71.26% faster | 68.50% faster |
| Brazil South | 70.07% faster | 69.47% faster |

### Trie point bundle

| Region | p50 change | p95 change |
| --- | ---: | ---: |
| East US | 64.71% faster | 51.68% faster |
| West US 2 | 66.50% faster | 76.87% faster |
| North Europe | 72.11% faster | 68.20% faster |
| Southeast Asia | 72.25% faster | 81.92% faster |
| Japan East | 68.36% faster | 71.69% faster |
| Australia East | 73.03% faster | 70.50% faster |
| Brazil South | 72.14% faster | 67.33% faster |

The primary point-read improvement repeated in every measured region.

## Large query results

| Query | Layout | Baseline p50 | Edge-warm p50 | Change | Baseline p95 | Edge-warm p95 | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Covered equality | Snapshot | 799.83 ms | 603.28 ms | 24.57% faster | 1,179.96 ms | 906.85 ms | 23.15% faster |
| Covered equality | Trie | 793.57 ms | 641.80 ms | 19.13% faster | 1,243.88 ms | 886.14 ms | 28.76% faster |
| Covered range | Snapshot | 1,046.03 ms | 897.08 ms | 14.24% faster | 1,590.56 ms | 1,369.24 ms | 13.91% faster |
| Covered range | Trie | 991.79 ms | 881.37 ms | 11.13% faster | 1,574.50 ms | 1,268.83 ms | 19.41% faster |
| Uncovered equality | Snapshot | 18,110.90 ms | 18,150.81 ms | 0.22% slower | 30,027.33 ms | 33,534.20 ms | 11.68% slower |
| Uncovered equality | Trie | 1,841.35 ms | 986.02 ms | 46.45% faster | 3,752.43 ms | 1,822.39 ms | 51.43% faster |

The large uncovered Snapshot query remained dominated by repeated processing
of the 10.25 MiB decoded snapshot. Removing two R2 reads did not improve it.
The same workload on Trie benefited because 116 immutable object reads moved
from R2 to the serving colo cache.

## Storage and request accounting

The edge cache did not change browser request count or object bytes delivered
to the browser.

For the large profile:

| Operation | Layout | Browser reads baseline/warm | R2 reads baseline/warm | Warm edge hits |
| --- | --- | ---: | ---: | ---: |
| Point | Snapshot | 2 / 2 | 2 / 1 | 1 |
| Point | Trie | 4 / 4 | 4 / 1 | 3 |
| Bundle | Trie | 1 / 1 | 4 / 1 | 3 |
| Covered equality | Snapshot | 2 / 2 | 2 / 1 | 1 |
| Covered equality | Trie | 2 / 2 | 2 / 1 | 1 |
| Uncovered equality | Snapshot | 3 / 3 | 3 / 1 | 2 |
| Uncovered equality | Trie | 117 / 117 | 117 / 1 | 116 |
| Scan | Snapshot | 2 / 2 | 2 / 1 | 1 |
| Scan | Trie | 274 / 274 | 274 / 1 | 273 |

Warm R2 bytes fell to the encrypted mutable HEAD:

- Snapshot HEAD: 339 bytes
- Trie HEAD: 312 bytes

The browser still received and validated the same encrypted immutable bytes.

## Forced cache misses

The primary large point paths remained close to direct R2:

| Path | p50 change | p95 change |
| --- | ---: | ---: |
| Snapshot point | 3.50% slower | 2.13% faster |
| Trie point | 0.56% slower | 3.54% faster |
| Snapshot bundle fallback | 3.82% faster | 3.65% faster |
| Trie bundle | 0.33% slower | 7.02% slower |

This passes the primary miss-path gate of no more than a 15% regression for
large point and bundle reads.

The 14-sample cold query and scan p95 values were less stable. Large covered
range p95 was 36-37% slower, and large uncovered equality p95 was 93-130%
slower, while their p50 values remained within about 2-9% of baseline. These
tails are retained in the raw evidence and prevent a claim that cache misses
are universally free.

## Full scans and high fan-out

Snapshot scans improved because one large immutable page moved from R2 to the
edge:

| Profile | Baseline p50 | Edge-warm p50 | Change | Baseline p95 | Edge-warm p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 356.78 ms | 206.09 ms | 42.24% faster | 871.90 ms | 837.13 ms | 3.99% faster |
| Medium | 411.45 ms | 238.57 ms | 42.02% faster | 695.58 ms | 407.38 ms | 41.43% faster |
| Large | 639.27 ms | 471.99 ms | 26.17% faster | 1,503.13 ms | 1,058.51 ms | 29.58% faster |

Trie scans still issued 119-274 caller requests. Across medium and large Trie
scan cases:

| Cache state | Medium success | Large success |
| --- | ---: | ---: |
| Baseline | 10/14 | 11/14 |
| Edge warm | 11/14 | 14/14 |
| Edge cold | 12/14 | 12/14 |

All 14 failures in the complete benchmark were `fetch failed` errors from
high-fan-out Trie scans. Every point and query operation succeeded.

Large warm Trie scan p50 improved by 52.20%, but p95 regressed by 59.28% due
to a 10.79 second outlier. The edge cache removes R2 work but does not remove
the 274 caller-to-Worker requests. It is not a correction for broad Trie
scans.

## Acceptance result

| Requirement | Result |
| --- | --- |
| Authorize before every cache lookup | Passed |
| Deny unauthorised access to an already-cached object | Passed |
| Cache only content-addressed encrypted objects | Passed |
| Keep mutable collection HEAD on R2 | Passed |
| Preserve point and query correctness | Passed |
| Reduce warm large Trie point p50 and p95 by at least 15% | Passed |
| Reduce warm large Trie bundle p50 and p95 by at least 15% | Passed |
| Repeat the primary improvement in every region | Passed |
| Reduce warm immutable R2 reads to HEAD-only | Passed |
| Keep primary large point and bundle misses within 15% of baseline | Passed |
| Improve the large uncovered Snapshot query | Failed |
| Make high-fan-out Trie scans reliable | Failed |
| Establish a realistic production cache-hit ratio | Not measured |
| Preserve provider-neutral deployment | Failed by design |

## Recommendation

Proceed to a production-shaped design review for an optional Cloudflare
authority cache. Do not merge the benchmark Worker or enable caching by
default.

The production candidate should retain these invariants:

- authenticate the session and authorize the scope before cache lookup
- allowlist only immutable content-addressed object paths
- never cache collection HEAD, auth data, grants, sessions, or error
  responses
- return private or no-cache responses to callers
- preserve ETags and browser-side TDB1 validation
- expose cache hit, miss, bypass, and failure metrics
- use a bounded configurable TTL
- define scope deletion and key-retirement behaviour
- fail explicitly if cache operations are malformed or unavailable

Before promotion, measure natural cache hit rates without forced prewarming.
This matters for ThimbleDB's target workloads because per-user collections
and geographically sparse traffic may not reuse the same object in the same
Cloudflare colo often enough to realise the best-case gains.

The feature should remain Cloudflare-specific and optional. Azure Blob, S3,
and local deployments should continue using the unchanged provider-neutral
storage protocol.

## Raw evidence

Repository artifact:

```text
evidence/immutable-edge-cache-regional-worker-2026-09-27.json
SHA-256 90E4E8337D6F7C1F0CBA2AF1DE03F0167DD5F6B260EEEE325557EA69FD8A9F32
```

The artifact contains:

- all 5,544 measured samples
- both independent replicates
- all seven regions
- Cloudflare colo values
- caller end-to-end latency
- browser request and byte counts
- R2 read and byte counts
- edge-cache hit, miss, bypass, and hit-byte counts
- all unauthorised probe results
- pooled and per-region summaries
- all 14 retained scan failures

## Cleanup verification

Cleanup completed and was verified:

```text
temporary workers.dev Worker: deleted, endpoint returns 404
temporary R2 objects: 700 deleted
temporary R2 bucket: deleted
temporary Azure resource group: deleted
```

Cache API entries used a one-hour TTL and a hostname belonging to the deleted
Worker. Cloudflare does not provide a global `cache.delete` operation for
colo-local Cache API entries. No route remains that can retrieve them, and
they expire automatically.

No production resource was used or changed by this evaluation.
