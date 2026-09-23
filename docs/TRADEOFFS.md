# Tradeoffs

## Proven by the current POC

- Browsers can read immutable object pages directly.
- Memory and IndexedDB materially reduce repeated network reads.
- ETag revalidation avoids downloading unchanged HEAD objects.
- A server write can return enough changed pages to update browser caches.
- Gzip before AES-GCM round-trips in Node and browser-compatible Web Crypto.
- Private object bodies do not contain plaintext JSON.
- Persistent browser cache entries can be encrypted with a non-extractable
  device key.
- The same envelope and trie code bundles for Node and Cloudflare Workers.
- R2 conditional operations map to the object-store compare-and-swap
  interface.

## Expected benefits that are not yet proven

- Lower total cost than a managed database for real user workloads.
- Better end-user latency than D1, Durable Objects, Turso, or Firestore.
- Sufficient operational simplicity for non-specialist developers.
- Safe key rotation at useful scale.
- Better performance from trie pages than adaptive immutable snapshots.
- Reliable production behaviour under multi-region write contention.
- A meaningful reduction in coding-agent database mistakes.

## Costs introduced by this design

- Application code must understand eventual cache freshness.
- Key grants and revocation become part of application security.
- A collection root is a write-contention point.
- Strong local password hashing adds material CPU and memory cost.
- Garbage collection and lifecycle policy are required.
- Browser storage quotas and eviction differ by browser.
- Direct encrypted reads expose ciphertext sizes and traffic patterns.
- Search, joins, and aggregate views require derived systems.

## When to use ThimbleDB

Good candidates:

- mostly idle web applications
- per-user or per-tenant datasets
- catalogues and configuration
- internal tools
- offline-tolerant CRUD applications
- applications whose hot working set fits in browser storage

Poor candidates:

- financial ledgers
- high-frequency shared counters
- large cross-tenant queries
- complex relational transactions
- workloads with strict immediate revocation
- applications unable to defend their browser origin against XSS

## Current recommendation

Continue as an experimental Cloudflare-first project. Do not position it as a
general database replacement. The next evidence should compare an adaptive
snapshot layout with the trie under encrypted browser workloads on R2.
