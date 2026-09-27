# Parallel write-pipeline regional experiment

This harness compares the current sequential authority write pipeline with
bounded parallel immutable work. It does not change object keys, HEAD shape,
index format, query planning, or browser read behavior.

The candidate:

- validates and prepares index pages before writing objects
- overlaps Snapshot and index uploads
- overlaps Trie node writes and index uploads
- limits independent index work to three concurrent operations
- awaits every immutable upload before conditional HEAD publication

The regional workload uses the current 25,000-document collection with two
covering indexes. Each Azure region and variant has an isolated fixture.
Replicates run against recreated empty buckets.

After every write sequence, the current browser client verifies one updated
document and one covered range query through the same object protocol.

Generated fixtures and regional results remain below
`.bench-data/parallel-write-regional`.

The default aggregate artifact is:

```text
evidence/parallel-write-regional-worker-2026-09-27.json
```

No production Worker, bucket, route, domain, package export, or storage
protocol is used or changed by this experiment.
