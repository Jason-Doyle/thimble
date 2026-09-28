# Browser mutation-batching experiment

This experiment compares ordinary one-document writes with one authoritative
multi-document commit.

The local matrix covers:

- 128, 5,000, and 25,000 documents
- zero, one, and two covering indexes
- Snapshot and Trie
- logical mutation groups of 1, 5, and 20 documents
- separate writes and one `putMany` batch

The regional matrix focuses on the 25,000-document, two-index case after the
local preflight establishes whether batching is worth cloud testing.

The caller sends ordinary JSON documents. It never supplies database roots,
index pages, hashes, or object-store keys. The authority performs validation,
state loading, index maintenance, immutable uploads, and final conditional
HEAD publication.

Each timed logical group is followed by an untimed verification request that
checks:

- every changed document is immediately readable
- the expected collection revision is visible
- batch size 5 and 20 publish one HEAD revision rather than one per document

The benchmark retains total and amortized latency, object operations, bytes,
object kinds, CAS failures, verification failures, and raw regional samples.

Acceptance requires:

- batch size 1 remains a neutral control
- batch size 5 reduces amortized p50 by at least 50 percent
- batch size 20 reduces amortized p50 by at least 75 percent
- one successful HEAD write per batch
- zero read-your-writes failures
- no deferred durability or success before HEAD publication

No production route, storage protocol, or browser API is changed by this
experiment.

The completed result and rejection boundaries are documented in
[`RESULTS.md`](RESULTS.md).
