# Should you use ThimbleDB for a vibe-coded app?

ThimbleDB is a candidate for small web applications with bounded JSON data,
clear ownership, more reads than writes, and modest write concurrency. It is
not a default database for every app built with an AI coding tool.

The useful question is not whether an app is "vibe coded." The useful question
is whether its data model and access patterns fit ThimbleDB's documented
boundaries.

## Short answer

Consider ThimbleDB when all of these statements are true:

- Each record belongs to one user, tenant, role, or public scope.
- The application mainly reads documents by ID or scans bounded collections.
- The working set is small enough to benefit from browser storage.
- Writes are occasional compared with reads.
- Writes can require a network connection.
- An external OIDC provider can own passwords, MFA, passkeys, and recovery.
- Object storage durability is a better fit than relational query flexibility.

Choose another database when any of these statements are true:

- The application needs joins or flexible cross-collection queries.
- Multiple records must change inside one ACID transaction.
- Shared records receive frequent concurrent writes.
- The product needs real-time collaborative editing.
- Offline writes must queue and merge automatically.
- Full-text search, vector search, or analytics are central features.
- The dataset is not meaningfully bounded.

## Why this can fit AI-assisted application development

AI coding tools are effective at assembling focused workflows, forms, JSON
models, API routes, and user interfaces. Many small apps produced this way use
a limited set of record types and simple ownership:

- personal notes and drafts
- small catalogues
- inspection records
- settings and preferences
- progress journals
- bounded task or project context
- internal reference data

ThimbleDB gives those applications a defined storage protocol instead of
asking the coding tool to invent one:

- object storage is the durable source of truth
- an application-owned authority handles identity and writes
- browsers retain encrypted data in memory and IndexedDB
- user and tenant scopes separate stored content
- conditional writes reject stale collection updates
- retained deletion supports restore and later physical collection
- snapshot and trie layouts cover different collection shapes

This can reduce database operations for the right workload. It does not remove
the need to design validation, ownership, retention, backup, and identity.

There is no published evidence that quantifies what proportion of vibe-coded
applications fit these constraints.

## The one-minute fit check

| Question | A ThimbleDB answer | A reason to choose something else |
| --- | --- | --- |
| Who owns a record? | One user, tenant, role, or public scope | Ownership depends on complex relationships |
| How is data read? | By ID, declared indexes, or bounded collection scan | Flexible ad hoc queries and joins |
| How often is data written? | Occasionally | Continuously or with high contention |
| How does offline mode work? | Previously read data remains available | Writes must queue and merge offline |
| Where are credentials stored? | External OIDC provider | The database must manage passwords |
| What is the durable backend? | R2, S3, Azure Blob, or local files | A relational or analytical engine |
| What is the expected scale? | Known and bounded collections | Unbounded datasets or reporting workloads |

If the left column does not describe the application, do not force the fit.

## Examples that fit

### Personal workspace

A user owns settings, drafts, bookmarks, and small task collections. Snapshot
layout works well for settings and small lists. Trie layout can take over when
point-read collections grow.

[Read the per-user workspace guide](use-cases/PER-USER-WORKSPACE.md).

### Internal tenant portal

A small organisation reads reference data frequently and updates operational
records occasionally. Tenant and user scopes keep records separate.

[Read the tenant operations guide](use-cases/TENANT-OPERATIONS.md).

### Field guide and inspections

Previously read guides remain available from encrypted browser cache. New
inspection writes wait for a network connection and pass through the
authority.

[Read the field guide guide](use-cases/FIELD-GUIDE.md).

### Structured context for an AI-assisted app

The app stores bounded preferences, task state, approved source material, and
results. Provider tokens, hidden reasoning, and unrestricted transcripts stay
outside the database.

[Read the structured AI context guide](use-cases/AI-CONTEXT.md).

## Examples that do not fit

Use another system for:

- financial ledgers and payment state
- inventory with frequent shared counters
- chat, presence, and collaborative documents
- complex scheduling with relational constraints
- global reporting across many tenants
- full-text or vector search
- large event streams and analytical workloads

PostgreSQL, SQLite, Cloudflare D1, Firestore, search engines, and analytical
databases each cover needs outside ThimbleDB's model.

## Five-minute local evaluation

Install and run the checked-in local notes example:

```powershell
cd examples\local-notes
npm install
npm run demo
npm test
```

The example uses the public package exports, a local `ObjectStore`, and the
immutable snapshot engine. It demonstrates deterministic document writes,
reads, and scans without an external database process.

For a complete local browser and authority flow:

```powershell
npx thimbledb@latest create my-notes-app
cd my-notes-app
npm run dev
```

The generated app includes the safe development identity, typed collection,
declared indexes, indexed title lookup, ordering, deletion, and restore.
The same local authority serves [ThimbleDB Studio](STUDIO.md) for inspecting
scopes, documents, query plans, indexes, exports, and retained deletions.

Then review:

1. [Quickstart](QUICKSTART.md)
2. [Architecture](ARCHITECTURE.md)
3. [Security](SECURITY.md)
4. [Tradeoffs](TRADEOFFS.md)
5. [Published benchmarks](BENCHMARKS.md)

## Prompt for a coding tool

Use this prompt before asking a tool to integrate ThimbleDB:

```text
Evaluate whether this application fits ThimbleDB before writing code.

Application:
[describe users, record types, expected collection sizes, reads, writes,
offline requirements, concurrent writers, queries, and identity provider]

Reject ThimbleDB if the application requires joins, multi-record ACID
transactions, high-frequency shared writes, full-text or vector search,
analytical queries, real-time collaboration, or offline write conflict
resolution.

If it fits:
1. Assign every collection to a user, tenant, role, or public scope.
2. Choose snapshot or trie layout from measured access patterns.
3. Use an external OIDC provider.
4. Keep storage credentials and scope keys out of browser persistence.
5. Start from the official ThimbleDB quickstart and public package exports.
6. Add tests for ownership, stale writes, logout, deletion, and restore.
7. Report every assumption and remaining operational responsibility.
```

More detailed prompts are available in
[Implementation prompts](IMPLEMENTATION-PROMPTS.md).

## How it compares

| Option | Prefer it when |
| --- | --- |
| [Cloudflare D1](compare/CLOUDFLARE-D1.md) | SQL, indexes, transactions, and managed recovery are important |
| [SQLite](compare/SQLITE.md) | One process or device needs a mature transactional SQL engine |
| [Firestore](compare/FIRESTORE.md) | Real-time listeners, client SDKs, offline writes, and flexible document queries are important |
| [lowdb](compare/LOWDB.md) | One process needs a very small JSON file database |
| [Direct JSON in object storage](compare/OBJECT-STORAGE.md) | The application only needs whole-object reads and writes and can own every consistency rule |

## What the evidence establishes

The published R2 browser run shows that:

- warm memory reads can be fast
- browser caching avoids repeated object downloads
- snapshot layout can reduce cold object requests for small collections
- cold reads and external session creation can still take seconds

The evidence does not establish:

- lower cost than a managed database
- better latency than D1, SQLite, Firestore, or another database
- safe high-contention multi-region writes
- suitability for an unmeasured production workload

Evaluate ThimbleDB against the real application's data and traffic before
choosing it.
