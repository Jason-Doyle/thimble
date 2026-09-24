# Changelog

All notable changes will be documented in this file.

The format follows Keep a Changelog and the package uses semantic versioning.

## Unreleased

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
- Added Apache-2.0 licensing, the ThimbleDB logo, a real
  `db.thimbledb.com` deployment, and raw three-region R2 browser evidence.

## 0.1.0

- Initial private research implementation and benchmark harness.
