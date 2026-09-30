# Trie index-page reuse benchmark

This benchmark measures the effect of reusing a Trie secondary-index page
after the authority has already loaded and validated it. The reuse path avoids
fetching the same immutable index page again during write preparation.

## What it compares

The paired control wraps the same engine and deliberately duplicates each
index-page read. This recreates the earlier operation count without
maintaining a separate engine implementation. Both paths therefore use the
same fixtures, write logic, process, and benchmark window.

## Run the local matrix

```powershell
npm run benchmark:trie-index-reuse
```

The local matrix covers:

- 128, 5,000, and 25,000 documents
- zero, one, and two indexes
- eight independent updates per case
- exact decoded protocol equivalence

The predeclared checks are:

- one authoritative read removed per configured index
- identical decoded keys and values
- no indexed p50 regression above 5 percent

Local timing isolates decoding, validation, index maintenance, encryption,
and compression. It does not represent end-to-end object-storage latency.

## Published findings

The paired local and regional findings are documented in
[RESULTS.md](RESULTS.md).

Index-page reuse removed one read per configured index and reduced indexed
read bytes by 35-50 percent. All six regional p50 values improved by 4-13
percent. The predeclared requirement for every medium and large p50 to improve
by at least 10 percent did not pass.

The implementation is present in ThimbleDB after merge commit `a7869ad`.
Applications do not need a migration or configuration change to receive the
reduced read count.
