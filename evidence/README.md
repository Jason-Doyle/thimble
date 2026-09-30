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

`write-scaling-regional-worker-2026-09-28.json` contains the post-merge
1,008-write matrix across seven Azure regions, two replicates, three
collection sizes, two layouts, and zero, one, and two indexes.

`write-scaling-regional-worker-2026-09-27.json` is the matching historical
pre-scheduler baseline. `write-scaling-comparison-2026-09-28.csv` provides a
compact case-by-case comparison without replacing either raw artifact.

The local artifacts isolate CPU and encoding cost. The
`write-scaling-local-baseline-rerun-2026-09-28.json` artifact reran the
historical source on the same machine and with the same eight-iteration
configuration as the post-merge local artifact.

`client-assisted-trie-writes-regional-worker-2026-09-29.json` contains the
1,008-write signed warm-context experiment across seven regions, two pristine
R2 replicates, three collection sizes, and zero, one, and two indexes.

`client-assisted-trie-writes-local-2026-09-29.json` contains the matching
local CPU and operation-count matrix. It includes the rejected full
tree-plus-index context. `client-assisted-trie-writes-summary-2026-09-29.csv`
is the compact regional projection.

SHA-256:

```text
Post-merge regional A433E2729528787929FCAED89448FBBCE3ED51977DEC6D8B95C06BC40BAD09DD
Post-merge local    C3273165AEA82CDE6B0EB052D174BFEDD3D7CAA8E7BC04329FC9C9D891924D63
Historical regional FB922BE12A86631482FC4EA52C21F8D29FD211F42E3C7C45765CC23E157FB0A3
Historical local    23B461C033F5BD16CC17AA199FA526D790898EDD4A289CE30FCE6427D4BB017D
Local baseline rerun B474B2017A0F275C0EB819B03EFA0DED469E09C82BCCBB8811788CBC183B063A
Client-write regional 5DF91D28F8D2ABF0140CF67D2EEA9E31BABC8BDABCC2E3CF44D1645191DFD73E
Client-write local    E06ADA00DCF9E0121ED2CC578C8F7AE0F7BA032EDB0837D7D762E8ABB0B9132C
Client-write summary  DE32822581956CAF24CE34B7DF120386BDFF60503EEB9B69FF98E068DFA14E0B
```
