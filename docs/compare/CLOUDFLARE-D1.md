# ThimbleDB and Cloudflare D1

Cloudflare D1 is a managed serverless SQL database with SQLite semantics,
Worker bindings, Time Travel recovery, and optional read replication.
ThimbleDB is an object-storage protocol with encrypted browser caching and an
application-owned authority.

Neither option is a general replacement for the other.

## Choose D1 when

- The application needs SQL, indexes, joins, or relational constraints.
- Multiple rows must change atomically.
- Managed point-in-time recovery is important.
- The data model changes through schema migrations.
- Queries are more important than browser-held encrypted objects.
- A Cloudflare-managed database service is acceptable.

D1 is designed to scale horizontally across many smaller databases. Each
individual database processes queries one at a time.

## Choose ThimbleDB when

- Data is naturally stored as bounded JSON documents.
- Records have simple user, tenant, role, or public ownership.
- Reads are by ID or bounded collection scan.
- The active working set benefits from encrypted browser cache.
- R2 or another object store should remain the durable source of truth.
- The application accepts connected writes through its authority.

## Capability comparison

| Capability | ThimbleDB | Cloudflare D1 |
| --- | --- | --- |
| Durable model | Encrypted objects in object storage | Managed SQLite-compatible database |
| Query model | ID reads and bounded scans | SQL with indexes and supported SQLite features |
| Transactions | Conditional collection-head updates | SQL transactions and batched statements |
| Browser cache | Built-in encrypted memory and IndexedDB tiers | Application-defined |
| Offline reads | Previously cached objects | Application-defined client caching |
| Offline writes | Not supported | Application-defined; D1 writes require Worker access |
| Recovery | Retained deletion and provider backup strategy | Time Travel and database restore |
| Identity | External OIDC through the application authority | Application-defined |
| Provider portability | R2, S3, Azure Blob, local files | Cloudflare D1 |
| Best fit | Bounded read-heavy document workloads | Relational and query-driven Worker applications |

## They can be used together

An application can use D1 for relational operational data and ThimbleDB for
encrypted, cacheable, user-scoped reference collections. This adds operational
complexity, so use both only when the data models are clearly different.

## Sources

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [ThimbleDB architecture](../ARCHITECTURE.md)
- [ThimbleDB benchmarks](../BENCHMARKS.md)
