# ThimbleDB and SQLite

SQLite is a self-contained, serverless, transactional SQL database engine that
reads and writes ordinary files. ThimbleDB stores encrypted immutable objects
in object storage and keeps an encrypted browser cache.

SQLite is the stronger default when a single process or device can own a
database file.

## Choose SQLite when

- The application needs SQL, indexes, joins, triggers, or views.
- ACID transactions are required.
- A server, desktop app, mobile app, or device can own the database file.
- Mature tooling, migrations, and a widely deployed file format matter.
- Data should remain available without a network connection.

## Choose ThimbleDB when

- The durable backend must be cloud object storage.
- Browsers need an encrypted cache of user or tenant scoped documents.
- The authority and browser run on different machines.
- Reads are mostly by ID, declared indexes, or bounded collection scan.
- Connected writes and external OIDC fit the product.

## Capability comparison

| Capability | ThimbleDB | SQLite |
| --- | --- | --- |
| Process model | Browser plus application authority | In-process embedded engine |
| Durable storage | Object storage | Local database file |
| Query model | ID reads, declared indexes, and bounded scans | SQL |
| Transactions | Conditional collection updates | ACID transactions |
| Multi-machine access | Through the authority and object store | Requires an application server or replication layer |
| Browser support | Purpose-built browser client and cache | Usually requires WASM or a server API |
| Offline writes | Not supported | Supported when the local process owns the file |
| Identity | External OIDC integration included | Application-defined |

## A common architecture

A Node application can use SQLite behind an HTTP API when relational
guarantees matter. Use ThimbleDB instead when the application specifically
benefits from private object storage, immutable pages, and browser caching.

## Sources

- [About SQLite](https://www.sqlite.org/about.html)
- [ThimbleDB architecture](../ARCHITECTURE.md)
- [ThimbleDB tradeoffs](../TRADEOFFS.md)
