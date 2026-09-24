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

## v1 release evidence

The v1 candidate includes:

- Apache-2.0 licensing
- frozen documented package and authority exports
- a real `db.thimbledb.com` Cloudflare Worker/R2 deployment
- Entra-backed identity mapping and administration
- retained deletion and quiescent physical collection
- explicit snapshot/trie recommendations and migration
- raw browser evidence from North Europe, US East, and Southeast Asia
- no unresolved high-severity correctness or security findings from the
  release review

The evidence does not claim latency superiority. Cold reads and external
session creation remain above the original stop/go targets.
