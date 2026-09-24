# Use cases

ThimbleDB fits applications with bounded JSON data, simple ownership,
read-heavy access, and modest write concurrency. It is not a general
replacement for relational, search, analytics, or real-time databases.

## Why many vibe-coded apps can fit

The term "vibe-coded app" is used here for a small application assembled
quickly with a coding tool, usually around a focused workflow rather than a
large data platform.

Many apps in that category share these characteristics:

- a small number of JSON-shaped record types
- one user or one small organisation owns most records
- direct reads by ID and occasional collection scans
- more reads than writes
- little or no relational joining
- low concurrent-write volume
- a hot working set small enough for browser storage
- external identity already supplied by the hosting platform

ThimbleDB matches those characteristics:

- Object storage is the durable backend.
- The authority supplies authentication, scope checks, key grants, writes,
  deletion, restoration, and administration.
- The browser retains encrypted content in memory and IndexedDB.
- User and tenant scopes keep data physically separated.
- Snapshot and trie layouts cover small scan-heavy and larger point-read-heavy
  collections.
- The package includes Node and Cloudflare authority endpoints instead of
  requiring every application to design its own storage protocol.

This can remove the need to operate a separate database engine for a small
application. It does not remove the need to design ownership, retention,
validation, backups, and identity-provider configuration.

There is no published evidence that quantifies how many vibe-coded apps fit
these constraints. Treat "many" as an architectural observation, not a market
or performance claim.

## Fast fit check

ThimbleDB is a reasonable candidate when every answer in the first group is
yes and every answer in the second group is no.

### Expected characteristics

- Can each record belong to one user, tenant, role, or public scope?
- Can the application use direct ID reads or bounded collection scans?
- Is the collection size known and reasonably small?
- Are writes occasional compared with reads?
- Can writes require an active network connection?
- Can external OIDC handle credentials, MFA, and recovery?
- Can the application tolerate seconds for some cold reads from distant
  regions while warm cached reads remain fast?

### Rejection criteria

- Does the application require multi-record ACID transactions?
- Does it require joins across collections or scopes?
- Does it require real-time collaborative editing?
- Does it depend on high-frequency shared counters?
- Does it require full-text, vector, or analytical queries?
- Does it require immediate revocation of plaintext already downloaded?
- Does it require offline write queues and automatic conflict resolution?
- Is the dataset too large for bounded object pages and browser caching?

## Published guides

| Guide | Primary scope | Recommended starting layout |
| --- | --- | --- |
| [Per-user workspace and drafts](use-cases/PER-USER-WORKSPACE.md) | User | Snapshot for settings and drafts; trie as collections grow |
| [Multi-tenant internal operations portal](use-cases/TENANT-OPERATIONS.md) | Tenant and user | Snapshot for reference data; trie for frequently updated records |
| [Offline-readable field guide and inspections](use-cases/FIELD-GUIDE.md) | User or tenant | Snapshot for guides; trie for inspection records |
| [Small catalogue or reference library](use-cases/CATALOGUE.md) | Tenant, role, or public | Snapshot for small catalogues; trie above measured thresholds |
| [Progress, training, or activity journal](use-cases/PROGRESS-JOURNAL.md) | User | Trie for entries; snapshot for profile and summary data |
| [Structured context for an AI-assisted application](use-cases/AI-CONTEXT.md) | User or tenant | Snapshot for preferences; trie for bounded task records |

Each guide includes workload assumptions, scope and collection suggestions,
layout guidance, deletion behaviour, a small TypeScript example, a scaffold
prompt, and a validation checklist.

## Use cases intentionally excluded

Do not present these as recommended ThimbleDB workloads:

- financial ledgers or payment systems
- chat or presence systems
- real-time collaborative documents
- high-frequency inventory or counter updates
- large reporting or analytics platforms
- full-text search engines
- vector databases
- relational transaction-heavy applications

These workloads need guarantees or query capabilities outside the documented
ThimbleDB model.
