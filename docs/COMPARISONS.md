# Database comparisons

These guides compare workload fit and documented guarantees. They do not rank
databases or claim that ThimbleDB is generally faster, cheaper, or simpler.

## Comparison guides

| Comparison | Start here when |
| --- | --- |
| [ThimbleDB and Cloudflare D1](compare/CLOUDFLARE-D1.md) | Choosing a Cloudflare-native data layer |
| [ThimbleDB and SQLite](compare/SQLITE.md) | Choosing between object storage and an embedded SQL engine |
| [ThimbleDB and Firestore](compare/FIRESTORE.md) | Choosing browser-oriented document storage and offline behaviour |
| [ThimbleDB and lowdb](compare/LOWDB.md) | Choosing a lightweight JSON-oriented option |
| [ThimbleDB and direct object storage](compare/OBJECT-STORAGE.md) | Deciding whether a storage protocol is worth adding |

## Compare the workload, not the product category

ThimbleDB has a narrow target:

- bounded JSON collections
- simple user or tenant ownership
- read-heavy access
- direct reads and bounded scans
- modest write concurrency
- encrypted browser caching
- application-owned object storage and identity

Choose another database when the application needs guarantees outside that
model.

## Evidence policy

The guides use official product documentation for competing systems and the
published ThimbleDB repository evidence. Differences are described as
capabilities and tradeoffs, not benchmark conclusions.
