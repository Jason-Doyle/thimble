# Tradeoffs

## Proven by the current POC

- Browsers can read immutable object pages through the authority broker.
- Memory and IndexedDB materially reduce repeated network reads.
- ETag revalidation avoids downloading unchanged HEAD objects.
- A server write can return enough changed pages to update browser caches.
- Gzip before AES-GCM round-trips in Node and browser-compatible Web Crypto.
- Private object bodies do not contain plaintext JSON.
- Persistent browser cache entries can be encrypted with a non-extractable
  device key.
- The same envelope, trie, and snapshot code bundles for Node and Cloudflare
  Workers.
- Real R2 conditional writes, external sessions, retained deletion, and
  snapshot migration work on the `db.thimbledb.com` reference deployment.

## Expected benefits that are not yet proven

- Lower total cost than a managed database for real user workloads.
- Better end-user latency than D1, Durable Objects, Turso, or Firestore.
- Sufficient operational simplicity for non-specialist developers.
- Safe key rotation at useful scale.
- Reliable production behaviour under multi-region write contention.
- A meaningful reduction in coding-agent database mistakes.

## Costs introduced by this design

- Application code must understand eventual cache freshness.
- Key grants and revocation become part of application security.
- A collection root is a write-contention point.
- Identity-provider availability affects new session creation.
- Garbage collection and lifecycle policy are required.
- Browser storage quotas and eviction differ by browser.
- Encrypted object access still exposes ciphertext sizes and traffic patterns
  to the authority and storage provider.
- Search, joins, and aggregate views require derived systems.

## When to use ThimbleDB

Good candidates:

- mostly idle web applications
- per-user or per-tenant datasets
- catalogues and configuration
- internal tools
- offline-tolerant, read-heavy applications with keyed updates
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
general database replacement. The next evidence should compare cost and
end-user behaviour in a real small application against one managed database.
