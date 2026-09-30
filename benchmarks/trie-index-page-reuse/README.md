# Trie index-page reuse benchmark

This benchmark measures a production-internal optimisation: a Trie write
reuses each secondary-index page already loaded and validated before mutation
preparation.

The control wraps the candidate engine and deliberately duplicates every
index-page read. This recreates the previous operation count in the same
process, fixture, and benchmark run.

## Local preflight

```powershell
npm run benchmark:trie-index-reuse
```

The local matrix covers:

- 128, 5,000, and 25,000 documents
- zero, one, and two indexes
- eight independent updates per case
- exact decoded protocol equivalence

Acceptance requires:

- one authoritative read removed per configured index
- identical decoded keys and values
- no indexed p50 regression above 5 percent

Regional evidence is required before merging the production change.

## Result

The completed paired local and regional result is documented in
[RESULTS.md](RESULTS.md).

The candidate removed one read per index and reduced indexed read bytes by
35-50 percent. All six regional p50 values improved by 4-13 percent, although
the predeclared 10-percent medium/large threshold did not pass in every case.

The production candidate is recommended for `main` because the redundant work
is removed deterministically, protocol output is unchanged, and no material
regression was observed.
