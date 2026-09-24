# Changelog

All notable changes will be documented in this file.

The format follows Keep a Changelog and the package uses semantic versioning.

## Unreleased

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
