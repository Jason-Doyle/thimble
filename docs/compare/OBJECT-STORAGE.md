# ThimbleDB and direct JSON in object storage

An application can store JSON objects directly in R2, S3, or Azure Blob
Storage without using ThimbleDB. That can be the simplest option when every
record is independent and the application owns all consistency rules.

ThimbleDB adds a protocol for the problems that appear once direct JSON grows
beyond whole-object reads and writes.

## Choose direct object storage when

- Each object can be replaced independently.
- Listing object keys is an acceptable query model.
- There are few concurrent writers.
- The application does not need browser cache coordination.
- Encryption, key distribution, deletion, and retention are already solved.
- A custom protocol is small enough to maintain safely.

## Choose ThimbleDB when

- Collections need deterministic layouts and conditional HEAD updates.
- Browsers should cache encrypted immutable pages.
- User and tenant scopes need separate keys and object prefixes.
- Writes require stale-client and stale-layout rejection.
- Deletion needs restore windows and later physical collection.
- Snapshot and trie layouts should share one document API.
- The application wants tested Node and Cloudflare authorities.

## Capability comparison

| Capability | ThimbleDB | Direct object storage |
| --- | --- | --- |
| Object format | Versioned TDB1 encrypted envelopes | Application-defined |
| Collection layout | Snapshot or content-addressed trie | Application-defined |
| Conditional writes | Defined ETag protocol | Provider API used directly |
| Browser cache | Memory and encrypted IndexedDB tiers | Application-defined |
| Key grants | Scoped, short-lived, memory-only | Application-defined |
| Identity | External OIDC mapping and sessions | Application-defined |
| Deletion | Tombstone, restore, grace, collection | Provider delete or custom process |
| Maintenance | Key migration, layout migration, retention tools | Application-defined |
| Complexity | More protocol, less application invention | Less initial code, more custom responsibility |

## A sensible progression

Start with direct object storage when the application only needs a few
independent JSON objects. Adopt a protocol such as ThimbleDB only when cache,
scope, consistency, deletion, or collection-layout requirements justify it.

## Sources

- [ThimbleDB protocol](../PROTOCOL.md)
- [ThimbleDB deletion and retention](../DELETION-RETENTION.md)
- [ThimbleDB adaptive layouts](../ADAPTIVE-LAYOUTS.md)
