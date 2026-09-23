# Architecture

ThimbleDB is a client-read, server-write database for small web
applications. Cloudflare Workers and R2 are the reference deployment. Azure
Blob Storage, Amazon S3, and a local filesystem adapter implement the same
storage abstraction.

See [System diagrams](DIAGRAMS.md) for trust boundaries, request sequences,
scope separation, and provider layouts.
See [Storage providers](STORAGE-PROVIDERS.md) for the provider contract and
conformance requirements.

## Reference path

```text
Browser
  decoded memory LRU
  encrypted IndexedDB cache
  read-only object requests
          |
          v
Private read broker
  session and scope validation
  encrypted binary envelopes from R2

Browser mutations
          |
          v
Cloudflare Worker
  local Argon2id or external OIDC authentication
  scope authorisation
  validation
  gzip then AES-256-GCM
  conditional R2 writes
  cache-update bundle response
```

The browser never receives an R2 API token, AWS secret, Azure account key, or
write-capable storage credential.

## Data scopes

Every collection tree belongs to one access scope:

```text
<application-prefix>/
  scopes/
    public/
      content-trie/
    tenant-123/
      content-trie/
    user-456/
      content-trie/
```

A scope can represent public data, one tenant, one user, or a role. Pages from
different scopes are never mixed. This is required because possession of a
scope key permits decryption of every page encrypted by that key.

Public scopes use the same binary envelope and adaptive gzip but omit
encryption. Private scopes use a versioned AES-256-GCM data key.

## Read path

1. The browser reads `HEAD.json` from memory or IndexedDB.
2. If its TTL expired, the browser revalidates HEAD with `If-None-Match`.
3. A 304 response keeps the current tree.
4. A changed HEAD points to an immutable root.
5. Root and branch pages identify the required leaf page.
6. The browser downloads only missing envelopes.
7. It decrypts, decompresses, parses, and retains the decoded value in memory.

Immutable pages do not need revalidation. Their object key identifies their
content within the scope and key version.

## Write path

1. The browser sends a mutation to the authority.
2. The authority authenticates the session and resolves allowed scopes.
3. Application validation runs before storage work.
4. Changed pages are serialised, gzip-compressed when useful, and encrypted.
5. New immutable pages are created.
6. HEAD is updated with an ETag compare-and-swap.
7. The response includes the new HEAD, root, branch, leaf, and changed
   document.
8. The writing tab updates its cache and broadcasts the bundle to other tabs.

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

## Provider model

The database engine depends on an ObjectStore interface rather than a cloud
SDK. Provider adapters supply bytes, ETags, conditional writes, deletion, and
prefix listing.

| Provider | Write authority | Durable storage | Browser read pattern |
| --- | --- | --- | --- |
| Cloudflare | Worker | R2 | Authenticated broker for private scopes; custom domain for public scopes |
| Local | Node process | Local filesystem | Same-origin authenticated broker |
| Azure | Container App or Node service | Blob Storage | Authenticated broker; optional SAS for public scopes |
| AWS | Lambda or another Node host | S3 | Authenticated broker; optional CloudFront for public scopes |

The stored envelope and trie protocol do not change between providers.
Cloudflare is preferred, not required.

## Current boundaries

- One HEAD serialises writes within a collection and scope.
- Garbage collection must run without concurrent stale writers in this POC.
- Local password auth requires a paid Worker or isolated hashing service at
  the documented Argon2id parameters.
- Revoking a user cannot erase plaintext they already downloaded.
- Full-text search, joins, analytics, and cross-scope queries require derived
  indexes or another system.
