# Frequently asked questions

## What is ThimbleDB?

ThimbleDB is an encrypted, browser-first database for small web applications.
Object storage is the durable source of truth. An application-owned authority
handles identity, access checks, key grants, writes, deletion, and
administration. Browsers keep a fast encrypted cache in memory and IndexedDB.

## What kind of application fits ThimbleDB?

The strongest fits have bounded JSON data, clear user or tenant ownership,
more reads than writes, direct reads by ID, and occasional collection scans.
Examples include personal workspaces, small internal tools, field guides,
catalogues, journals, and bounded context for AI-assisted applications.

## When should I use another database?

Use another system when the application needs multi-record ACID transactions,
joins, high-frequency shared writes, real-time collaboration, full-text
search, vector search, large analytical queries, or unrestricted reporting
across tenants.

## Is ThimbleDB a replacement for PostgreSQL or SQLite?

No. ThimbleDB serves a narrower workload. It avoids a continuously running
database engine by storing encrypted immutable objects and small mutable
location records in object storage. Relational databases remain the better
choice when relationships, transactions, and flexible queries are central to
the application.

## Does ThimbleDB require Cloudflare?

No. Cloudflare Workers and R2 are the reference deployment. The package also
includes a Node authority with local filesystem, Azure Blob Storage, Amazon
S3, and S3-compatible adapters. The stored protocol remains the same across
providers.

## Can the authority run in-app or as a separate Worker?

Both are supported. The authority can run in-app inside the application
deployment or as a separate Worker, container, function, or Node service. A
separate process should normally remain behind the same public browser origin
through path-based routing so Strict cookies, CSRF, Studio, browser caches,
and logout coordination retain the documented behaviour.

Use an in-app authority for the smallest operational surface. Use a separate
authority when storage-secret isolation, independent release control, failure
isolation, regional placement, or independent scaling justifies another
service. Separation creates a scaling boundary; it does not remove collection
write contention. See
[In-app and separate authority deployment](AUTHORITY-DEPLOYMENT.md).

## Does ThimbleDB store passwords?

No. Applications use Microsoft Entra or another OpenID Connect provider.
ThimbleDB stores stable external identity mappings and revocable sessions, but
passwords, passkeys, MFA factors, recovery, and verification remain with the
identity provider.

## Is data encrypted?

Yes. ThimbleDB canonicalises JSON, applies adaptive gzip, and encrypts objects
with AES-256-GCM. Authenticated data binds each encrypted envelope to its
canonical object key. Private object addresses can also be derived with
HMAC-SHA-256.

## Can an application work offline?

Previously read objects can remain available from encrypted browser cache when
the network is unavailable. Writes require the authority and an active network
connection. ThimbleDB does not provide an offline write queue or automatic
conflict resolution.

## How does deletion work with immutable objects?

Document deletion first writes an encrypted tombstone. The default restore
window is 30 days, followed by a seven-day purge grace period. Physical object
collection is an explicit maintenance operation performed while writes are
quiescent.

## Does ThimbleDB support SQL or joins?

No. The current API supports document reads, writes, deletion, restoration,
declared secondary indexes, and bounded collection scans. It does not claim
SQL, joins, aggregation, full-text search, or vector query semantics.

## How fast is it?

Warm in-memory reads were sub-millisecond at p50 in the authenticated browser
run. The newer 3,808-operation test used seven regional Node clients and
25,000 documents at its largest profile. Snapshot cold point-read p95 was
1.62 seconds, Trie was 3.23 seconds, and Trie bundle was 2.69 seconds.

Covering indexes avoided full-document reads, while large uncovered snapshot
queries, trie scans, and simultaneous multi-region writes exposed clear poor
fits. These measurements describe specific Cloudflare and Azure runs. They do
not establish general superiority over another database.

## Is it suitable for vibe-coded applications?

It can fit focused applications that use a small number of JSON record types,
simple ownership, bounded collections, and modest write concurrency. The
repository includes implementation prompts and complete use-case guides for
coding tools. There is no published evidence that quantifies what proportion
of vibe-coded applications fit these constraints.

## Who owns the data and deployment?

The application operator does. The domain, object storage, identity provider,
keys, authority, retention policy, and backups remain in the consumer's cloud
account. ThimbleDB does not require a hosted ThimbleDB service.

## What does the base package install?

The base package installs ThimbleDB and `jose`, which provides standards-based
OIDC and JWT verification without transitive runtime dependencies. Azure and
AWS SDKs are optional and are installed only for the matching Node storage
adapter.

## Can ThimbleDB query indexed fields?

Yes, for bounded queries inside one scope and collection. Applications declare
equality, range, or composite indexes. A typed fluent query compiles to a
serialisable expression and uses a matching immutable index page when
available. ID equality remains a direct point read.

Indexes may declare bounded covering fields. An explicit `.select(...)` query
can return those fields without full-document reads when every predicate,
ordering, and selected field is covered.

ThimbleDB does not provide joins, aggregates, cross-scope queries, automatic
indexing of every field, or a general distributed query engine.

## Can data be migrated into or out of ThimbleDB?

Yes. Versioned logical archives use checksummed NDJSON collections and support
dry-run, create, replace, and merge imports. Adapters cover JSON, CSV, lowdb,
SQLite, PostgreSQL, and Firestore.

Logical archives contain plaintext application data and must be protected like
database exports.

## Does the administrator role read every database scope?

No. `thimble.admin` authorizes identity-administration endpoints. It is not a
global data bypass.

Human live viewers should use OIDC and receive only the tenant memberships and
tenant roles they require. Headless callers can use an OIDC service principal
and exchange a short-lived application token for a normal ThimbleDB session.
See [Machine and service access](SERVICE-ACCESS.md).

## Is there a database management frontend?

Yes. ThimbleDB Studio ships in the npm package and can be hosted by the same
Node or Cloudflare authority. It browses explicit granted scopes, runs bounded
queries, reports index health, edits and restores documents, exports NDJSON,
and exposes guarded maintenance operations.

Studio starts read-only and never receives object-storage credentials. See
[ThimbleDB Studio](STUDIO.md).

## How do I report a bug or documentation problem?

Use the [GitHub issue tracker](https://github.com/Jason-Doyle/thimble/issues)
for reproducible defects, documentation corrections, and feature proposals.
Do not include credentials, tokens, private application data, or other
sensitive information in a public issue.

## Does thimbledb.com use analytics cookies?

The static documentation site uses Cloudflare Web Analytics. Cloudflare
describes that service as privacy-first analytics that does not use cookies or
collect visitors' personal data. The site has no user accounts, comments, or
contact forms. See [Website privacy](WEBSITE-PRIVACY.md).

## What licence does ThimbleDB use?

ThimbleDB is available under the Apache License 2.0.
