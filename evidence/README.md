# Raw evidence

This directory contains selected benchmark artifacts that support documented
claims.

`azure-standard-small.json` is the unmodified result produced by:

```powershell
npm run benchmark -- --provider azure --profile small
```

The artifact contains operation counts, bytes, latency percentiles, conflicts,
cache metrics, object counts, and stored bytes. It contains no credentials.

Machine, network path, Azure region, and time of day affect the result. Treat
it as one reproducible observation, not a universal performance claim.

`r2-current-layout-multiregion-2026-09-25.json` contains the complete raw and
aggregated result from 3,808 measured operations across seven Azure regions
and two replicates. It covers the current snapshot, trie, read-bundle,
secondary-index, scan, single-writer, multi-region contention, and
decoded-envelope-limit paths.

`r2-current-layout-summary-2026-09-25.csv` is a compact tabular projection of
the same evidence for plotting and independent analysis.

The corresponding source revisions, methodology, failures, and limitations
are embedded in the JSON artifact and documented in
`docs/BENCHMARKS.md`.

`immutable-edge-cache-regional-worker-2026-09-27.json` contains 5,544
measured operations across seven Azure regions and two replicates. It compares
the current authorized R2 path with forced Cloudflare edge-cache misses and
prewarmed colo-local encrypted immutable objects.

The implementation, result tables, decision, limitations, and cleanup record
are documented in `benchmarks/immutable-edge-cache/RESULTS.md`.
