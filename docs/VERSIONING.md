# Versioning and compatibility

ThimbleDB has three version surfaces.

## Package version

The npm package follows semantic versioning after 1.0:

- patch: compatible bug and security fixes
- minor: compatible APIs and optional protocol capabilities
- major: breaking public API or supported-protocol changes

The current package remains private and versioned `0.1.0`. Its exports are
usable for evaluation but are not yet frozen.

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

## v1 release gate

A true v1 requires:

- a chosen licence
- frozen documented package exports
- successful Cloudflare R2 conformance and cost benchmarks
- a real application using external OIDC authentication
- documented document-deletion and retention semantics
- an explicit decision on adaptive snapshot versus trie layout
- no high-severity correctness or security findings
