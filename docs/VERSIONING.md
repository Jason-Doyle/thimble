# Versioning and compatibility

ThimbleDB has three version surfaces.

## Package version

The npm package follows semantic versioning after 1.0:

- patch: compatible bug and security fixes
- minor: compatible APIs and optional protocol capabilities
- major: breaking public API or supported-protocol changes

Package version `1.0.0` freezes the documented exports in
[Public package API](PUBLIC-API.md). Semantic versioning applies to the root,
auth, authority, and provider subpaths.

## Version 1.0

Version 1.0 provides:

- Apache-2.0 licensing
- stable documented package and authority exports
- Node and Cloudflare authority implementations
- Entra and generic OIDC identity mapping and administration
- retained deletion and quiescent physical collection
- explicit snapshot/trie recommendations and migration
- TDB1 read compatibility fixtures

Performance is not part of the compatibility guarantee. Published R2 evidence
shows fast warm cache reads, while cold reads and external session creation can
take seconds from distant regions.

## Version 2.0

Version 2 separates cloud storage SDKs from the base package:

- local, browser, and Cloudflare consumers no longer install Azure and AWS
  SDKs
- Azure deployments install `@azure/storage-blob`
- S3 and R2-over-S3 deployments install `@aws-sdk/client-s3`
- provider classes are available from explicit `thimbledb/providers/*`
  subpaths

This is a major release because existing Azure and S3 installations must add a
direct provider dependency before upgrading.

## Version 2.1

Version 2.1 adds compatible application APIs and tooling:

- ready browser connection factory
- typed collections and schema-compatible parsing
- bounded serialisable query expressions
- explicit equality, range, and composite secondary indexes
- code-configured authority layouts and indexes
- loopback-only development identity
- project scaffolding and diagnostics CLI
- versioned logical migration archives
- JSON, CSV, lowdb, SQLite, PostgreSQL, and Firestore migration adapters

No stored TDB1 envelope change is required. Collection HEAD objects gain
optional secondary index references that older clients ignore.

Upgrade all authority instances before enabling indexes. An older authority
can publish a new HEAD without index references because it does not maintain
them. After the rollout, run `npx thimbledb rebuild-indexes` while writes are
quiescent.

## Version 3.0

Version 3.0 adds the optional ThimbleDB Studio frontend and its
authority-managed metadata and maintenance endpoints.

- Studio assets ship in the main npm package.
- Node authorities can serve `/studio/` directly.
- Cloudflare deployments can copy the same assets into their Worker asset
  build.
- Studio APIs remain opt-in.
- Data access still requires explicit scope grants.
- Snapshot HEADs gain authenticated record, tombstone, and decoded-byte
  metadata.
- Trie branches retain string child hashes and gain an optional sibling
  metadata map that version 2 readers ignore.
- Existing collections require `thimbledb migrate-metadata` before bounded
  Studio export, deleted-item listing, or scan queries.

This is a major release because bounded query behavior now fails closed when
legacy collections do not yet contain authenticated size metadata.

## Version 3.1

Version 3.1 adds compatible read and index optimizations:

- authorities may explicitly advertise a bounded point-read bundle endpoint
- clients use one browser request on eligible cold point reads
- clients fall back to individual object reads when the capability is absent
  or bounded limits reject the bundle
- secondary index definitions may declare up to eight covering fields
- typed `.select(...)` projections can use those fields without loading full
  documents

The TDB1 envelope and collection HEAD formats are unchanged. Index pages gain
optional definition and projection fields that older readers ignore. Upgrade
every writing authority before enabling covering fields, then rebuild the
affected indexes while writes are quiescent.

## Object protocol version

`TDB1` is stored in every object envelope. Protocol compatibility is separate
from npm package version.

Committed fixtures under `protocol-fixtures/v1` must remain decodable by every
release that claims TDB1 read compatibility. Tests decode the fixtures in Node,
Chromium, Firefox, and WebKit.

Changing the envelope header, authentication data, compression interpretation,
or key identifier rules requires a new protocol version or an explicitly
compatible extension.

## Key versions

`THIMBLE_KEY_VERSION` selects the write key. Historical versions listed in
`THIMBLE_READ_KEY_VERSIONS` remain readable.

The `npm run migrate:keys` command rewrites selected live collections under the
current write key. Old objects are retained until an operator-approved offline
cleanup.
