# Benchmarks

ThimbleDB benchmarks are reproducible workload measurements for application
developers, operators, and contributors. They document observed behaviour,
including failures and thresholds that were not met. They do not claim
general performance or cost superiority over another database.

## Published benchmark sets

| Benchmark | Purpose |
| --- | --- |
| [Current-layout regional](current-regional/README.md) | Measures released read, query, scan, write, contention, and decoded-envelope-limit paths across seven regions |
| [Write scaling](write-scaling/README.md) | Measures Snapshot and Trie writes across collection sizes and index counts |
| [Trie index-page reuse](trie-index-page-reuse/README.md) | Measures the effect of reusing index pages already loaded during write validation |
| [Comparative application harness](comparative/README.md) | Defines one deterministic notes workload for adapters without presenting unlike local architectures as a product comparison |

## How to read the reports

Each published result should identify:

- the exact implementation and harness revisions
- dataset size, operation count, regions, and replicates
- the primary latency timer and retained diagnostic timers
- failures, retries, and rejected cases
- predeclared acceptance or rejection checks
- limitations that restrict the supported conclusion
- raw evidence paths and SHA-256 hashes

Raw JSON and CSV artifacts are the source of truth. Tables and graphs are
projections for review and should be reproducible from those artifacts.

## Interpreting results

Use results to assess a workload similar to the measured matrix. Network
path, cloud region, object-store conditions, runtime version, data shape,
indexes, and concurrency can materially change latency.

A benchmark improvement does not remove documented architecture limits. In
particular:

- warm browser reads and cold remote operations are different paths
- one mutable collection HEAD remains a write-contention boundary
- collection-wide index pages still scale with indexed data
- temporary cloud measurements are observations, not service-level
  objectives

See [Benchmark evidence](../docs/BENCHMARKS.md) for the consolidated public
report and [Raw evidence](../evidence/README.md) for retained artifacts.
