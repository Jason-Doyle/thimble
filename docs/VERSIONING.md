# Versioning and compatibility

ThimbleDB has three version surfaces.

## Package version

The npm package follows semantic versioning after 1.0:

- patch: compatible bug and security fixes
- minor: compatible APIs and optional protocol capabilities
- major: breaking public API or supported-protocol changes

Package version `1.0.0` freezes the documented exports in
[Public package API](PUBLIC-API.md). Semantic versioning applies to the root,
auth, and authority subpaths.

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
