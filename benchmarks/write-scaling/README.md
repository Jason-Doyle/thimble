# Production write-scaling experiment

This benchmark measures the unchanged production Snapshot and Trie write
paths across:

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

No production code, Worker, bucket, route, or custom domain is changed.
