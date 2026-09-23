# Object protocol

ThimbleDB stores immutable pages and one mutable HEAD per collection and
access scope.

## Tree layout

```text
scopes/<scope-id>/
  content-trie/<collection>/
    HEAD.json
    nodes/<opaque-address>.json
```

The `.json` suffix is retained for recognisable object names. The object body
is a binary ThimbleDB envelope, not plaintext JSON.

`HEAD.json` decodes to:

```json
{
  "revision": 42,
  "rootHash": "opaque-address"
}
```

Root nodes map the first SHA-256 identifier nibble to branch addresses.
Branches map the second nibble to leaf addresses. Leaves contain documents.

Private node addresses use HMAC-SHA-256 with a scope-derived address key.
Public deployments still use stable opaque addresses, but confidentiality is
not expected for public content.

## Binary envelope version 1

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII magic `TDB1` |
| 4 | 1 | Flags |
| 5 | 2 | Big-endian key ID byte length |
| 7 | 1 | IV byte length |
| 8 | variable | UTF-8 key ID |
| next | variable | AES-GCM IV |
| next | remaining | Payload |

Flags:

| Bit | Meaning |
| ---: | --- |
| 0 | Payload was gzip-compressed |
| 1 | Payload was AES-256-GCM encrypted |

For encrypted envelopes, the complete header and canonical scoped object key
are supplied to AES-GCM as additional authenticated data. Copying a valid
encrypted object to another key therefore fails authentication. The ciphertext
includes the 128-bit GCM tag.

Public envelopes have no key ID or IV. They may still be gzip-compressed.

## Compression rule

Gzip is attempted by default. The encoder keeps compressed bytes only when
they save more than the configured minimum. Tiny values therefore remain
uncompressed instead of paying gzip header overhead.

This is measurable per object and does not require a collection-wide format
choice.

## Conditional writes

Immutable pages use create-if-absent.

HEAD uses compare-and-swap against its current ETag. A failed precondition
causes the writer to reload the new tree, apply its mutation again, and retry.

Provider mappings:

| Protocol operation | Azure Blob | S3 | R2 Worker binding |
| --- | --- | --- | --- |
| Create if absent | `If-None-Match: *` | `IfNoneMatch: *` | `etagDoesNotMatch: *` |
| Compare and swap | `If-Match: <etag>` | `IfMatch: <etag>` | `etagMatches: <etag>` |

The local adapter implements the same contract with an in-process per-key
lock. It is a development provider, not a cross-process coordination
mechanism.

## Cache update bundle

A successful write response contains:

- new revision
- changed document
- HEAD
- root
- changed branch
- changed leaf

This removes a read-after-write round trip and lets other tabs update through
BroadcastChannel.

## Compatibility policy

The envelope magic and version are durable protocol fields. Before a public
1.0 release, compatibility fixtures must cover:

- public compressed and uncompressed objects
- encrypted compressed and uncompressed objects
- each supported key version
- corrupt header and authentication failures
- objects produced in browsers, Node, and Workers
