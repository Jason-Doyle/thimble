# Write-scaling benchmark

This benchmark characterises Snapshot and Trie write behaviour across:

- 128 documents
- 5,000 documents
- 25,000 documents
- zero secondary indexes
- one covering equality index
- two covering indexes

The regional harness runs from seven Azure regions against a temporary
Cloudflare Worker and R2 bucket. Each case and region has an isolated fixture.
Replicates use recreated empty buckets.

The benchmark retains:

- caller-observed end-to-end latency
- Worker I/O-oriented elapsed time
- object read and write counts
- object bytes
- R2 duration grouped by HEAD, snapshot, Trie node, and index object
- CAS retries and failures

The matching local benchmark uses an in-memory object store without simulated
latency to isolate encoding, encryption, compression, and index-maintenance
cost.

## How to use the results

Use the regional evidence to estimate the observed object-storage latency
floor, index amplification, and regional spread for small read-heavy
applications. Use the local evidence to separate CPU and encoding work from
network and provider latency.

The results are workload-specific observations, not general latency or cost
guarantees. The complete interpretation and raw artifact hashes are in
[RESULTS.md](RESULTS.md).

The harness uses temporary Workers, buckets, and Azure callers. It does not
modify a production ThimbleDB deployment.
