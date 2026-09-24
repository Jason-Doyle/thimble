# Quickstart

ThimbleDB requires an external OIDC provider. It does not store passwords,
passkeys, MFA factors, or recovery credentials.

Choose one authority:

- Cloudflare Worker with R2 for the reference deployment
- Node authority with local, Azure Blob, S3, or R2 storage

The browser API is the same for every authority.

## Install

```powershell
npm install thimbledb
```

ThimbleDB is ESM-only and requires Node.js 22 or newer for Node deployments.
The base package does not install Azure or AWS SDKs.

For a Node authority backed by Azure Blob:

```powershell
npm install @azure/storage-blob
```

For a Node authority backed by Amazon S3 or R2 through the S3 API:

```powershell
npm install @aws-sdk/client-s3
```

Cloudflare Worker, browser-only, and local Node deployments do not need either
provider SDK.

## Cloudflare Worker and R2

Create `src/worker.ts`:

```ts
export { default } from "thimbledb/authority/cloudflare";
```

Create two private R2 buckets:

```powershell
npx wrangler r2 bucket create <data-bucket>
npx wrangler r2 bucket create <auth-bucket>
```

Use a Wrangler configuration with caller-owned resources:

```jsonc
{
  "name": "my-thimbledb-authority",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-23",
  "workers_dev": false,
  "vars": {
    "THIMBLE_PREFIX": "prod",
    "THIMBLE_KEY_VERSION": "1",
    "THIMBLE_READ_KEY_VERSIONS": "",
    "THIMBLE_HEAD_TTL_MS": "10000",
    "THIMBLE_COLLECTION_LAYOUTS": "",
    "THIMBLE_RETIRED_COLLECTION_LAYOUTS": "",
    "THIMBLE_DELETE_RETENTION_DAYS": "30",
    "THIMBLE_DELETE_GRACE_DAYS": "7",
    "THIMBLE_MAINTENANCE_MODE": "false",
    "THIMBLE_ALLOWED_ORIGIN": "https://app.example.com",
    "ENTRA_TENANT_ID": "<tenant-id>",
    "ENTRA_AUDIENCE": "<api-client-id>",
    "ENTRA_REQUIRED_SCOPE": "thimble.access",
    "ENTRA_REQUIRED_ROLE": "thimble.user"
  },
  "r2_buckets": [
    {
      "binding": "DB",
      "bucket_name": "<data-bucket>"
    },
    {
      "binding": "AUTH_DB",
      "bucket_name": "<auth-bucket>"
    }
  ],
  "routes": [
    {
      "pattern": "db.example.com",
      "custom_domain": true
    }
  ]
}
```

Generate and store the master key without writing it to source:

```powershell
$masterKey = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
$masterKey | npx wrangler secret put THIMBLE_MASTER_KEY
$masterKey = $null
```

Deploy:

```powershell
npx wrangler deploy
```

Apply the auth-session lifecycle rules from
`deploy/cloudflare/auth-lifecycle.example.json`. Do not apply an independent
age-based lifecycle rule to the data bucket because it cannot determine which
immutable objects remain reachable.

## Node authority

Create `server.mjs`:

```js
import { startNodeAuthority } from "thimbledb/authority/node";

await startNodeAuthority();
```

For local development:

```powershell
$env:THIMBLE_PROVIDER = "local"
$env:THIMBLE_ALLOWED_ORIGIN = "http://127.0.0.1:5173"
$env:OIDC_PROVIDER_ID = "my-provider"
$env:OIDC_ISSUER = "https://identity.example.com/"
$env:OIDC_AUDIENCE = "thimbledb-api"
$env:OIDC_JWKS_URI = "https://identity.example.com/.well-known/jwks.json"
$env:OIDC_REQUIRED_SCOPE = "thimble.access"
node server.mjs
```

The local adapter stores application objects under `.thimble-data` and auth
records under `.thimble-auth`. It is intended for one Node process.

Before selecting `azure`, install `@azure/storage-blob`. Before selecting `s3`
or `r2`, install `@aws-sdk/client-s3`. For provider environment variables,
trusted proxy, and secure-cookie configuration, use the deployment guides.

## Browser client

Obtain an API access token through the application's OIDC authorization-code
flow with PKCE. Do not hard-code or persist the access token.

Exchange it for a ThimbleDB session:

```ts
await fetch("/api/auth/oidc/entra/session", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  },
  body: "{}",
});
```

Create the client from authority configuration:

```ts
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  IndexedDbObjectCache,
  MemoryObjectCache,
  ScopedJsonObjectReader,
  ThimbleClient,
  TieredObjectCache,
  base64ToBytes,
  importAesGcmKey,
} from "thimbledb";

const config = await fetch("/api/config", {
  credentials: "same-origin",
  cache: "no-store",
}).then((response) => response.json());

const grant = await fetch(config.scope.keyEndpoint, {
  credentials: "same-origin",
  cache: "no-store",
}).then((response) => response.json());

const keys = new Map();
for (const item of grant.keys) {
  const raw = base64ToBytes(item.key);
  keys.set(
    item.keyId,
    await importAesGcmKey(raw, ["decrypt"], false),
  );
  raw.fill(0);
}

const reader = new ScopedJsonObjectReader(
  new EnvelopeJsonObjectReader(
    new HttpByteObjectReader(config.readBaseUrl),
    (keyId) => keys.get(keyId) ?? null,
  ),
  config.scope.id,
);

const cache = new TieredObjectCache(
  new MemoryObjectCache(),
  new IndexedDbObjectCache(
    `${location.origin}:${config.scope.id}`,
  ),
  config.cachePolicy,
);

const db = new ThimbleClient({
  reader,
  cache,
  headTtlMs: config.headTtlMs,
  csrfToken: config.csrfToken,
  scopeId: config.scope.id,
  keyExpiresAt: grant.expiresAt,
  collectionLayouts: config.collectionLayouts,
  layoutGeneration: config.layoutGeneration,
  configurationUrl: "/api/config",
  onLayoutChange: () => location.reload(),
});
```

Read and mutate documents:

```ts
await db.write("notes", "note-1", {
  id: "note-1",
  title: "First note",
  body: "Stored through ThimbleDB",
});

const note = await db.get("notes", "note-1");
const notes = await db.scan("notes");

await db.delete("notes", "note-1");
await db.restore("notes", "note-1");
```

## Verify the integration

Confirm:

1. `/api/auth/config` lists the expected OIDC provider.
2. The session cookie is HttpOnly, SameSite=Strict, and Secure in production.
3. `/api/config` returns the expected internal user scope.
4. Brokered objects begin with `TDB1`.
5. R2, S3, or Blob credentials never reach the browser.
6. Scope keys exist only as non-extractable in-memory CryptoKeys.
7. Logout blocks later object reads and clears the browser cache.
8. Delete and restore follow the configured retention window.
9. A stale layout generation receives `409 layout_changed`.

Continue with [Authentication](AUTHENTICATION.md),
[Deletion and retention](DELETION-RETENTION.md), and
[Adaptive layouts](ADAPTIVE-LAYOUTS.md).
