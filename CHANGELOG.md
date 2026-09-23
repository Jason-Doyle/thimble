# Changelog

All notable changes will be documented in this file.

The format follows Keep a Changelog and the package will use semantic
versioning once its public API is declared stable.

## Unreleased

- Added a typed package export surface for browser, protocol, trie, envelope,
  and authentication APIs.
- Added Cloudflare, local, Azure, and AWS authority deployments.
- Added local Argon2id authentication and Entra/OIDC token exchange.
- Added TDB1 protocol fixtures and Chromium, Firefox, and WebKit tests.
- Added historical key reads and a collection key-migration command.
- Disabled destructive garbage collection in production engines.
- Added bounded request parsing, trusted proxy handling, and provider-backed
  account rate limits.
- Hardened logout/cache races, external identity refresh, password-change
  concurrency, and first-use key creation.

## 0.1.0

- Initial private research implementation and benchmark harness.
