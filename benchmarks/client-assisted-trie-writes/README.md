# Client-assisted Trie write experiment

This experiment tests whether a warm client can reduce authoritative
object-store reads during an ordinary Trie update without moving trust to the
client.

The client context contains:

- an authority-signed, short-lived HEAD value and ETag
- the cached root, branch, and leaf values for the updated document
- optionally, cached secondary-index pages referenced by that HEAD

The authority:

1. verifies the HEAD signature, scope, collection, layout generation, and
   expiry
2. canonicalises every supplied immutable value and recomputes its
   content-addressed key
3. uses verified values only as a request-local read overlay
4. delegates every missing object to the authoritative store
5. publishes the next HEAD with the signed ETag as `If-Match`
6. falls back to the ordinary authoritative write after a stale HEAD conflict
   or invalid, expired, or missing context

The signing key must be server-only and independently derived from the
deployment master key. It must not be the scope encryption key delivered to
the browser.

The browser never supplies database objects that bypass authority
verification. HEAD remains the final conditional write.

## Local matrix

```powershell
npm run benchmark:client-write-context
```

The local preflight covers:

- 128, 5,000, and 25,000 documents
- zero, one, and two secondary indexes
- ordinary baseline writes
- warm Trie-path context
- full Trie-path plus index context
- six independent updates per case

Each candidate must produce the same decoded keys and bytes as the baseline.

## Acceptance thresholds

- every valid assisted write succeeds without fallback
- invalid and expired context falls back before candidate immutable writes
- stale context fails the HEAD CAS and then preserves both the concurrent and
  requested mutations through the ordinary path
- full context performs zero authoritative reads during the assisted attempt
- medium and large indexed full-context p50 improves by at least 25 percent
- the large two-index context remains at or below 4 MiB

Local timing is a CPU and operation-count preflight. A successful local result
still requires regional object-storage evidence before production promotion.
