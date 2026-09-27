# Adaptive HEAD revalidation experiment

Date: 27 September 2026

Branch: `experiment/adaptive-head-revalidation`

Tested main commit:

```text
623a253349d2b9ee6cbf5fbc25b2391d1627366e
```

Tested harness commit:

```text
c27acf71de55e5ddae116af49e81e1f1095bdf4b
```

## Decision

The experiment supports two separate conclusions.

First, timestamping a successful HEAD revalidation when its response
completes is a small correctness improvement over the current request-start
timestamp. It prevents a slow `304 Not Modified` response from being expired
as soon as it arrives. The pooled performance effect was modest, but the
request reduction was material in Southeast Asia, where HEAD latency was a
larger fraction of the one second TTL.

Second, adaptive 1-10 second revalidation is a valid configurable consistency
mode, but it should not replace the current default.

Adaptive mode:

- reduced stable HEAD request rate by about 77%
- moved stable p90 from about 198 ms to below 1 ms
- improved stable read throughput by about 15%
- preserved correctness and cached offline reads
- detected an immediate second remote change with no stale cached reads after
  resetting to the one second minimum

It also allowed a first remote change after a quiet period to remain stale for
about 8.7-9.4 seconds at p50 and up to 10.6 seconds at p95.

The useful conclusion is:

> Adaptive revalidation is a real request-versus-freshness tradeoff. It is
> suitable only when the application explicitly accepts bounded cross-client
> staleness.

## Why the current timestamp matters

The current client records `checkedAt` before starting a HEAD request.

If a one second TTL revalidation takes longer than one second, the refreshed
cache entry is already expired when the `304` response arrives. The next read
immediately revalidates again.

The experimental policy hook allows successful revalidation to record
response-completion time instead. It retains the current request-start
behaviour as the benchmark control.

This change alone did not create the large adaptive gain. Pooled one second
completion-timed request rate was only 3.6-4.1% lower than current behaviour.
In Southeast Asia it reduced stable request rate by 16.6-20.8%, confirming
that the timing defect matters most when network latency approaches the TTL.

## Candidate adaptive policy

Each cached collection HEAD starts at the configured one second TTL.

After every unchanged HEAD:

```text
1 s -> 2 s -> 4 s -> 8 s -> 10 s
```

The interval is capped at 10 seconds.

The interval resets to one second after:

- a changed HEAD response
- a missing HEAD response
- a newer read or write bundle is applied

The adaptive state is memory-only. A page reload starts conservatively at one
second.

Immutable objects retain their existing permanent content cache behaviour.
The Snapshot and Trie storage protocols are unchanged.

## Scope

The candidate remains isolated:

- no production Worker change
- no public configuration option
- no package export
- no storage protocol change
- no migration
- no custom domain
- no change to `thimbledb.com`

## Regional method

The benchmark used:

- real headless Chromium 153
- seven Azure regions
- two independent replicates
- Snapshot and Trie layouts
- one deterministic document per isolated scenario
- four revalidation policies
- 112 complete scenarios
- 14,705 measured browser reads

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

Each scenario measured:

1. one cold point read
2. 20 seconds of unchanged hot reads
3. a successful revalidation boundary
4. a protected remote mutation immediately after that boundary
5. polling until version 1 became visible
6. a second remote mutation immediately after version 1 was observed
7. polling until version 2 became visible
8. a cached read with the object route offline

The first mutation is deliberately near worst case. It occurs immediately
after the policy has declared HEAD fresh.

## Stable unchanged reads

### Snapshot

| Policy | p50 | p90 | p95 | HEAD reads/minute | Reads/second |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current 1 s | 0.6 ms | 198.2 ms | 243.0 ms | 52.07 | 3.333 |
| Completion-timed 1 s | 0.6 ms | 195.4 ms | 224.8 ms | 49.91 | 3.373 |
| Fixed 10 s | 0.5 ms | 0.7 ms | 0.8 ms | 4.04 | 3.928 |
| Adaptive 1-10 s | 0.5 ms | 0.7 ms | 80.5 ms | 11.93 | 3.834 |

Adaptive change versus current:

- p90: 99.65% faster
- p95: 66.87% faster
- HEAD request rate: 77.09% lower
- read throughput: 15.03% higher

### Trie

| Policy | p50 | p90 | p95 | HEAD reads/minute | Reads/second |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current 1 s | 0.7 ms | 197.7 ms | 246.8 ms | 52.89 | 3.313 |
| Completion-timed 1 s | 0.7 ms | 194.6 ms | 228.0 ms | 50.98 | 3.356 |
| Fixed 10 s | 0.6 ms | 0.8 ms | 1.0 ms | 5.96 | 3.898 |
| Adaptive 1-10 s | 0.6 ms | 0.8 ms | 75.9 ms | 11.93 | 3.828 |

Adaptive change versus current:

- p90: 99.60% faster
- p95: 69.25% faster
- HEAD request rate: 77.44% lower
- read throughput: 15.54% higher

The adaptive p95 still includes remote revalidation. The p90 result is the
clearer user-visible change: at least 90% of stable reads stayed local after
the policy reached its cap.

## First remote change after a quiet period

The mutation occurred immediately after a successful policy boundary.

| Policy | Snapshot p50 | Snapshot p95 | Trie p50 | Trie p95 |
| --- | ---: | ---: | ---: | ---: |
| Current 1 s | 814.8 ms | 2,726.1 ms | 1,599.0 ms | 2,940.3 ms |
| Completion-timed 1 s | 811.1 ms | 1,918.3 ms | 1,566.7 ms | 3,328.9 ms |
| Fixed 10 s | 9,370.4 ms | 11,291.3 ms | 8,598.6 ms | 9,663.0 ms |
| Adaptive 1-10 s | 9,372.5 ms | 10,555.1 ms | 8,711.4 ms | 9,487.9 ms |

Adaptive stale reads:

| Layout | p50 | p95 |
| --- | ---: | ---: |
| Snapshot | 34 | 38 |
| Trie | 28 | 35 |

This is the cost of the request reduction. The first cross-client change can
remain invisible for the complete adaptive interval.

The observed p95 remained within the 10 second cap plus regional network and
processing time.

## Immediate second remote change

After version 1 became visible, the adaptive policy reset to one second. The
benchmark then published version 2 immediately.

| Policy | Snapshot p50 | Snapshot p95 | Trie p50 | Trie p95 |
| --- | ---: | ---: | ---: | ---: |
| Current 1 s | 777.0 ms | 1,813.7 ms | 1,635.8 ms | 3,784.5 ms |
| Completion-timed 1 s | 768.1 ms | 2,334.8 ms | 1,614.7 ms | 2,648.0 ms |
| Fixed 10 s | 8,831.1 ms | 9,546.8 ms | 7,354.8 ms | 8,830.9 ms |
| Adaptive 1-10 s | 804.2 ms | 2,414.9 ms | 1,576.4 ms | 3,930.7 ms |

Adaptive stale reads were zero at p50 and p95 for both layouts. Detection time
was therefore the first minimum-interval revalidation plus regional network
latency, rather than another 10 second wait.

This reset behaviour is the material improvement over a fixed 10 second TTL.

## Regional adaptive behaviour

Adaptive stable HEAD request rate remained tightly grouped:

| Layout | Minimum | Maximum |
| --- | ---: | ---: |
| Snapshot | 11.87/min | 11.98/min |
| Trie | 11.88/min | 12.00/min |

First-change p95:

| Region | Snapshot | Trie |
| --- | ---: | ---: |
| East US | 9,860.7 ms | 9,487.9 ms |
| West US 2 | 9,591.5 ms | 9,152.0 ms |
| North Europe | 9,498.1 ms | 8,711.4 ms |
| Southeast Asia | 9,747.7 ms | 8,709.3 ms |
| Japan East | 10,555.1 ms | 9,354.2 ms |
| Australia East | 9,134.4 ms | 8,462.9 ms |
| Brazil South | 9,345.1 ms | 8,947.1 ms |

Immediate-second-change p95:

| Region | Snapshot | Trie |
| --- | ---: | ---: |
| East US | 360.5 ms | 764.5 ms |
| West US 2 | 286.8 ms | 807.1 ms |
| North Europe | 740.4 ms | 1,556.3 ms |
| Southeast Asia | 1,931.2 ms | 3,930.7 ms |
| Japan East | 2,414.9 ms | 2,561.4 ms |
| Australia East | 954.7 ms | 1,795.0 ms |
| Brazil South | 825.5 ms | 1,593.7 ms |

The reset worked in every region. The remaining delay follows regional
request latency and the greater number of Trie objects needed after a changed
HEAD.

## Offline fallback and security

All 112 scenarios returned version 2 from the cached immutable objects after
the object route was forced offline. Every scenario recorded exactly one
offline HEAD fallback.

Each of the 14 regional runs also verified:

| Probe | Expected | Result |
| --- | ---: | ---: |
| Configuration without token | 403 | 14/14 returned 403 |
| Scenario preparation without token | 403 | 14/14 returned 403 |

## Acceptance result

| Requirement | Result |
| --- | --- |
| Reduce stable HEAD request rate by at least 60% | Passed, about 77% |
| Preserve Snapshot and Trie correctness | Passed |
| Preserve cached offline fallback | Passed, 112/112 |
| Keep first-change p95 within cap plus network | Passed |
| Reset to minimum interval after changed HEAD | Passed |
| Detect immediate second change without stale cached reads | Passed |
| Separate request-start timing from adaptive gain | Passed |
| Improve freshness versus the current one second policy | Failed by design |
| Provide one universally better default | Failed |

## Recommendation

Do not make adaptive 1-10 second revalidation the default.

Two follow-up changes are defensible:

1. Move the response-completion timestamp correction into a small production
   change. It fixes the pathological case where a slow `304` arrives already
   expired, while preserving the configured one second freshness target.
2. Offer adaptive revalidation only as an explicit opt-in policy with a
   bounded maximum interval. It fits mostly idle, read-heavy, or reference
   collections where fewer authority requests matter more than immediate
   cross-client freshness.

Applications with collaborative or latency-sensitive remote updates should
retain the short fixed interval unless a push or invalidation channel is
added.

An eventual production option should:

- keep the minimum interval explicit
- require an explicit maximum interval
- reset after changed or missing HEAD responses
- reset after newer read or write bundles
- restart conservatively after page reload
- revalidate when a page returns to the foreground
- expose current interval, 304 count, changed-HEAD count, and offline fallback
  metrics

The experiment should remain on this branch until the response-completion fix
and any opt-in adaptive API are reviewed separately.

## Raw evidence

Repository artifact:

```text
evidence/adaptive-head-revalidation-regional-browser-2026-09-27.json
SHA-256 B87E34F62E8D1136F43C1AD050FFADEAC9CB90FDCF8AD334C76F864A5B4BB50B
```

The artifact contains:

- all 14 regional browser results
- 112 complete policy and layout scenarios
- 14,705 measured reads
- both independent replicates
- Chromium and Cloudflare colo values
- cold, stable, boundary, mutation, and offline samples
- HEAD request and 304 counts
- adaptive policy diagnostics
- all unauthorised probe results
- pooled and per-region summaries

## Cleanup verification

Cleanup completed and was verified:

```text
temporary workers.dev Worker: deleted, endpoint returns 404
temporary R2 objects: 857 deleted
temporary R2 bucket: deleted
temporary Azure resource group: deleted
```

No production resource was used or changed by this evaluation.
