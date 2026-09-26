# Changelog

All notable changes will be documented in this file.

The format follows Keep a Changelog and the package uses semantic versioning.

## Unreleased

- Bounded normal authority and browser envelope reads to 16 MiB decoded by
  default, with explicit per-wrapper overrides for advanced integrations.
- Rejected oversized writes before storage and stopped gzip decompression as
  soon as the configured decoded limit is exceeded.

## 3.1.0 - 2026-09-25

- Added opt-in bounded point-read bundles that reduce cold trie and snapshot
  reads to one browser request when the authority advertises the endpoint.
- Kept automatic fallback to the existing encrypted-object path for older
  authorities, legacy metadata, and bundles above the four-object or 4 MiB
  decoded limits.
- Added explicit covering fields to declared secondary indexes.
- Bounded each covering projection to 64 KiB and every immutable index page to
  4 MiB before changed document objects are written.
- Added typed query projections through `.select(...)`; covered queries can
  return declared fields from the index without loading full documents.
- Kept full-document reads for ordinary queries and whenever a predicate,
  ordering field, or selected field is not covered.
- Documented embedded and separately deployed authority topologies and their
  operational tradeoffs.

## 3.0.0 - 2026-09-25

- Added the optional ThimbleDB Studio management frontend to the npm package.
- Added explicit-scope collection discovery, layout and revision metadata,
  index-health inspection, retained-deletion listing, and checksummed NDJSON
  export.
- Added read-only-first document browsing, bounded query construction, query
  plan display, guarded editing, deletion, and restore.
- Added guarded index rebuild and expired-deletion purge actions.
- Added direct Node hosting at `/studio/` and a CLI command for copying the
  same assets into Cloudflare or another static host.
- Required explicit scope write access in addition to `thimble.admin` for
  scope maintenance operations.
- Added authenticated snapshot and trie metadata for pre-read record,
  tombstone, and decoded-byte bounds.
- Added `thimbledb migrate-metadata` for upgrading existing collections while
  authorities are quiescent.

## 2.1.0 - 2026-09-24

- Added a ready browser client factory and used it in the reference browser.
- Added typed collections, schema-compatible parsing, fluent bounded queries,
  direct ID planning, and explicit local predicates.
- Added developer-declared equality, range, and composite secondary indexes
  published atomically through collection HEAD records.
- Added code-configured Node and Cloudflare authority layouts and indexes.
- Added a loopback-only, non-production development identity.
- Added the `thimbledb create` scaffolder and `thimbledb doctor`.
- Added maintained Node and Cloudflare GitHub template repositories.
- Added an Entra scope and application-role manifest generator.
- Documented OIDC service-principal access and the global admin-key boundary.
- Regenerated system diagrams for queries, indexes, migration, service
  identities, cache isolation, and key rotation.
- Namespaced custom caches by authority and scope.
- Prevented indexed maintenance from silently dropping index references.
- Added stale-client detection for active scope-key rotation.
- Added versioned checksummed logical archives with dry-run, create, replace,
  and merge imports.
- Added JSON, CSV, lowdb, SQLite, PostgreSQL, and Firestore migration adapters.
- Added a reproducible comparative application harness without product
  superiority claims.

## 2.0.0 - 2026-09-24

- Split local, Azure Blob, and S3 adapters into explicit provider exports.
- Changed Azure and AWS SDKs from mandatory dependencies to optional peer
  dependencies.
- Made the Node authority load cloud adapters only when their provider is
  selected.
- Added package verification for the lightweight base install and provider
  installs.
- Kept the supplied generic and AWS container images self-contained by
  installing their required runtime adapters explicitly.
- Corrected the npm publishing guide to describe signed provenance for the
  public repository.

## 1.0.5 - 2026-09-24

- Added an npm trusted-publishing workflow using GitHub Actions OIDC.
- Added first-publish, trusted-publisher, token-restriction, and release
  instructions.

## 1.0.4 - 2026-09-24

- Removed the hosted reference domain from tracked documentation, benchmark
  tooling, and evidence metadata.
- Switched README branding to the checked-in logo asset.
- Changed the repository homepage to the GitHub repository.

## 1.0.3 - 2026-09-24

- Added a workload fit guide for small vibe-coded applications.
- Added six complete use-case guides with data models, layout choices,
  examples, scaffold prompts, caveats, and validation checklists.
- Documented the workloads that should use a relational, search, analytics, or
  real-time system instead.

## 1.0.2 - 2026-09-24

- Added Cloudflare, Node, and browser quickstart guides.
- Added copy-paste implementation, deployment, migration, and review prompts
  for coding tools.
- Updated README branding and repository metadata.

## 1.0.1 - 2026-09-24

- Rewrote public documentation for application developers and operators.
- Renamed the proof-of-concept guide to the evaluation harness.
- Limited published benchmark documentation to live Cloudflare R2 browser
  measurements.

## 1.0.0 - 2026-09-24

- Added a typed package export surface for browser, protocol, trie, envelope,
  authentication, and authority APIs.
- Added Cloudflare, local, Azure, and AWS authority deployments.
- Added Entra and generic OIDC token exchange with stable internal user
  mappings.
- Added TDB1 protocol fixtures and Chromium, Firefox, and WebKit tests.
- Added historical key reads and a collection key-migration command.
- Disabled destructive garbage collection in production engines.
- Added bounded request parsing, trusted proxy handling, and provider-backed
  external-identity rate limits.
- Hardened logout/cache races, external identity refresh, and first-use key
  creation.
- Removed local password accounts and delegated credentials, recovery,
  verification, passkeys, and MFA to Entra or another OIDC provider.
- Added an external-auth migration that preserves internal user IDs while
  removing legacy password material, local identity indexes, and sessions.
- Added dual-proof identity linking, provider-role administration, internal
  access assignments, and full-session revocation.
- Added retained deletion, restoration, user/tenant scope erasure, and
  explicitly quiescent physical collection.
- Added browser-compatible immutable snapshots, advisory trie/snapshot
  selection, maintenance-mode migration, and live adaptive deployment.
- Added reusable Node and Cloudflare authority package exports.
- Added Apache-2.0 licensing, the ThimbleDB logo, a live Cloudflare/R2
  deployment, and raw three-region R2 browser evidence.

## 0.1.0

- Initial storage-engine implementation and benchmark harness.
