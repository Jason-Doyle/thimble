# Architecture

ThimbleDB is a client-read, server-write database for small web
applications. Cloudflare Workers and R2 are the reference deployment. Azure
Blob Storage, Amazon S3, and a local filesystem adapter implement the same
storage abstraction.

See [System diagrams](DIAGRAMS.md) for trust boundaries, request sequences,
scope separation, and provider layouts.
See [In-app and separate authority deployment](AUTHORITY-DEPLOYMENT.md) for
placement, scaling, secret-boundary, and same-origin choices.
See [Storage providers](STORAGE-PROVIDERS.md) for the provider contract and
conformance requirements.

## Reference path

```text
Browser
  authority-and-scope-namespaced memory LRU
  authority-and-scope-namespaced encrypted IndexedDB cache
  typed point, index, and bounded-scan queries
          |
          v
Private read broker
  session and scope validation
  encrypted binary envelopes from R2
  optional bounded HTTPS cache-value bundles for cold point reads

Browser mutations
          |
          v
Cloudflare Worker
  external OIDC authentication and identity mapping
  scope authorisation
  validation
  declared secondary-index maintenance
  gzip then AES-256-GCM
  conditional R2 writes
  cache-update bundle response
```

The browser never receives an R2 API token, AWS secret, Azure account key, or
write-capable storage credential.

The optional Studio frontend is built and versioned with the npm package. It
uses the same browser client, object broker, sessions, and explicit scope
grants as application code.

## Data scopes

Every collection tree belongs to one access scope:

```text
<application-prefix>/
  scopes/
    public/
      content-trie/ or content-snapshot/
    tenant-123/
      content-trie/ or content-snapshot/
    user-456/
      content-trie/ or content-snapshot/
```

A scope can represent public data, one tenant, one user, or a role. Pages from
different scopes are never mixed. This is required because possession of a
scope key permits decryption of every page encrypted by that key.

Public scopes use the same binary envelope and adaptive gzip but omit
encryption. Private scopes use a versioned AES-256-GCM data key.

## Read path

1. The browser first checks the authority-and-scope cache namespace.
2. On a cold point read, a version 3.1 authority can return a bounded HEAD and
   immutable-object bundle in one browser request.
3. Older authorities, legacy metadata, oversized bundles, and cache hits use
   the individual encrypted-object path.
4. If a cached HEAD TTL expired, the browser revalidates it with
   `If-None-Match`.
5. A 304 response keeps the current layout generation.
6. ID equality resolves directly to one document path.
7. A matching declared index resolves a bounded set of candidate IDs.
8. An explicit `.select(...)` can use declared covering fields without
   loading full documents.
9. Queries without a usable index use an explicitly bounded scan.
10. Trie HEAD points to an immutable root, branch, and leaf path.
11. Snapshot HEAD points to one immutable collection snapshot.
12. The browser coalesces concurrent reads of the same immutable object.
13. It re-evaluates the complete predicate, orders, limits, and returns the
    query plan with the documents.

Immutable pages do not need revalidation. Their object key identifies their
content within the scope and key version.

Individual object reads remain TDB1 envelopes that the browser decrypts.
Bounded read bundles are assembled by the trusted authority and carry decoded
cache values over HTTPS with `no-store`; object storage remains encrypted and
private.

## Write path

1. The browser sends a mutation to the authority.
2. The authority authenticates the session and resolves allowed scopes.
3. Application validation runs before storage work.
4. Changed trie pages or the next immutable snapshot are serialised,
   gzip-compressed when useful, and encrypted.
5. Every configured secondary index and declared covering projection is
   updated or rebuilt.
6. New immutable document and index objects are created.
7. HEAD publishes the document root and all active index references with one
   ETag compare-and-swap.
8. The response includes the new HEAD, changed immutable objects, and
   document.
9. The writing tab updates its cache and broadcasts the bundle to other tabs.

Conditional HEAD writes are the transaction boundary for one collection and
scope. Cross-collection transactions are not supported.

## Cache layers

| Layer | Contents | Lifetime |
| --- | --- | --- |
| Memory | Decoded hot objects | Current tab, bounded LRU |
| IndexedDB | Device-key-encrypted cached objects | Persistent browser cache |
| Object storage | Gzip-compressed public envelopes or gzip plus AES-GCM private envelopes | Durable source of truth |

The scope data key remains memory-only. IndexedDB has a separate
non-extractable device key. Clearing cached objects retains that shared key so
another tab cannot create entries that a newly generated key cannot decrypt.
Logout-time key rotation requires cross-tab coordination.

Every cache key is namespaced by authority URL and scope ID, including custom
cache implementations. Reusing one cache object across users or tenants
cannot return another scope's decoded values.

## Provider model

The database engine depends on an ObjectStore interface rather than a cloud
SDK. Provider adapters supply bytes, ETags, conditional writes, deletion, and
prefix listing.

| Provider | Write authority | Durable storage | Browser read pattern |
| --- | --- | --- | --- |
| Cloudflare | Worker | R2 | Authenticated Worker broker |
| Local | Node process | Local filesystem | Same-origin authenticated broker |
| Azure | Container App or Node service | Blob Storage | Authenticated authority broker |
| AWS | Lambda or another Node host | S3 | Authenticated authority broker |

The stored envelope, trie, and snapshot protocols do not change between providers.
Cloudflare is preferred, not required.

## Boundaries

- One HEAD serialises writes within a collection and scope.
- Document roots and declared secondary indexes become visible through the
  same HEAD update.
- Equality indexes contain scalar tuples; range indexes contain one scalar
  field. Non-scalar predicates use bounded scans.
- Production engines retain old generations. Destructive garbage collection is
  available only in an explicitly enabled, quiescent maintenance mode.
- Every deployment uses an external OIDC identity provider. ThimbleDB stores
  only the stable provider-to-internal-user mapping and revocable sessions.
- Revoking a user cannot erase plaintext they already downloaded.
- Full-text search, joins, analytics, and cross-scope queries require derived
  indexes or another system.
