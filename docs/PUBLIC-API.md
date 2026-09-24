# Public package API

ThimbleDB is deployable on an application's own domain. The package does not
depend on a vendor-hosted service.

## Stable exports

### `thimbledb`

The root export contains:

- `ThimbleClient` and browser cache/read primitives
- `ContentAddressedTrieEngine`
- `ImmutableSnapshotEngine`
- TDB1 envelope encode/decode helpers
- ObjectStore and prefix/envelope wrappers
- trie and snapshot protocol types
- layout advisor types and `recommendCollectionLayout`

Clients created from `/api/config` should pass `collectionLayouts`,
`layoutGeneration`, and `configurationUrl` into `ThimbleClient`. Mutations send
the generation header automatically, and stale clients clear caches and invoke
`onLayoutChange` before reading a retired layout.

### `thimbledb/auth`

The auth export contains:

- `AuthService`
- `AuthRepository`
- `OidcIdentityAdapter` and `createEntraAdapter`
- scope authorizer and rate-limiter implementations
- public identity, session, principal, and grant types

Credential policy, password recovery, verification, passkeys, and MFA remain
the external provider's responsibility.

### `thimbledb/authority/node`

```ts
import { startNodeAuthority } from "thimbledb/authority/node";

await startNodeAuthority();
```

The Node authority reads documented environment variables and serves the same
authentication, object broker, key grant, write, deletion, linking,
administration, retention, and layout-migration endpoints used by the
reference deployment.

### `thimbledb/authority/cloudflare`

```ts
import authority from "thimbledb/authority/cloudflare";

export default authority;
```

The Cloudflare authority uses caller-owned R2 and asset bindings. Routes,
custom domains, buckets, OIDC applications, and secrets belong to the
consumer's account.

### `thimbledb/providers/local`

```ts
import { LocalObjectStore } from "thimbledb/providers/local";
```

The local entry point also exports `PrefixObjectStore`, `CachedObjectStore`,
and `MeteredObjectStore`. It has no cloud SDK dependency.

### `thimbledb/providers/azure`

```powershell
npm install @azure/storage-blob
```

```ts
import { AzureBlobObjectStore } from "thimbledb/providers/azure";
```

The Azure SDK is an optional peer dependency and is loaded only when this
adapter or the Node authority's `azure` provider is used.

### `thimbledb/providers/s3`

```powershell
npm install @aws-sdk/client-s3
```

```ts
import { S3ObjectStore } from "thimbledb/providers/s3";
```

The AWS SDK is an optional peer dependency. The same adapter supports Amazon
S3 and R2 through the S3 API.

## Compatibility commitments

- Semantic versioning applies from package version `1.0.0`.
- TDB1 envelopes and committed protocol fixtures remain readable throughout
  the 1.x line.
- New optional object layouts may be added in a minor release.
- Removing or changing an exported symbol, authority endpoint, stored field,
  or required configuration value is a major-version change.
- Security fixes may reject malformed or legacy data that was never valid
  under the documented protocol.

Version 2 separates provider SDK installation from the base package. Azure,
S3, and S3-compatible Node deployments must install their documented optional
peer dependency.

## Supported runtimes

- Node.js 22 or newer
- current and previous stable Chromium
- current and previous stable Firefox
- current and previous stable WebKit/Safari
- ESM only
