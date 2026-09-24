# Deploy to Cloudflare

Cloudflare Workers and R2 are the reference ThimbleDB deployment.

The maintained reference instance is `https://db.thimbledb.com`. It uses
private `thimbledb-data` and `thimbledb-auth` R2 buckets, Microsoft Entra,
snapshot layouts for products and customers, a ten-second HEAD TTL, and the
documented auth lifecycle rules.

The design uses:

- one Worker for static assets, writes, sessions, and scope-key grants
- one R2 data bucket for encrypted application objects
- one private R2 auth bucket for users, sessions, and rate records
- an optional native rate-limit binding
- an authenticated Worker read broker for private scopes

R2 Standard currently includes 10 GB-month storage, 1 million Class A
operations, 10 million Class B operations, and free egress each month.

## 1. Build

```powershell
npm install
npm run build:client
npm run build:worker
```

The current dry-run Worker bundle is about 33.8 KB gzip. Record the compressed
size during release checks.

## 2. Authenticate Wrangler

```powershell
npx wrangler login
```

## 3. Create R2 storage

Create separate data and auth buckets:

```powershell
npx wrangler r2 bucket create <data-bucket-name>
npx wrangler r2 bucket create <auth-bucket-name>
```

Do not use Infrequent Access for the initial deployment. The R2 free tier
applies to Standard storage. Never attach a custom domain to the auth bucket.

## 4. Configure the application domain

Use one Worker hostname:

```text
db.example.com
```

Object reads pass through the Worker and require a valid session and scope
grant. No R2 custom domain or browser CORS rule is required.

## 5. Create Wrangler configuration

Copy the disabled example beside the original so its relative paths remain
valid:

```powershell
Copy-Item deploy\cloudflare\wrangler.example.jsonc deploy\cloudflare\wrangler.local.jsonc
```

Edit `deploy\cloudflare\wrangler.local.jsonc`:

1. Uncomment the `r2_buckets` block.
2. Set the real data and auth bucket names.
3. Optionally configure `AUTH_RATE_LIMITER` for low-latency source-IP limits.
   OIDC-subject limits always use the encrypted R2-backed limiter.
4. Uncomment the Worker custom-domain route.
5. Set the exact `THIMBLE_ALLOWED_ORIGIN`.

The example keeps bindings and routes commented so copying the repository
cannot deploy infrastructure accidentally.

## 6. Configure authentication

Every deployment uses Entra or another OIDC identity provider. ThimbleDB stores
only the stable external-identity mapping, current application roles and
tenants, and revocable sessions.

For Entra, set `ENTRA_TENANT_ID` and `ENTRA_AUDIENCE`. The application obtains
an API access token through a reviewed OIDC client and exchanges it at
`/api/auth/oidc/entra/session`.

Also set `ENTRA_REQUIRED_SCOPE` or `ENTRA_REQUIRED_ROLE`.

For another provider, set `OIDC_PROVIDER_ID`, `OIDC_ISSUER`,
`OIDC_AUDIENCE`, and `OIDC_JWKS_URI`, plus at least one of
`OIDC_REQUIRED_SCOPE` or `OIDC_REQUIRED_ROLE`. A valid first exchange creates
the minimal internal mapping and stable `user:<uuid>` data scope.

Cloudflare Access can remain an additional outer boundary around the
application hostname.

## 7. Create secrets

Generate independent values:

```powershell
$masterKey = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store them through Wrangler without writing them to a file:

```powershell
$masterKey | npx wrangler secret put THIMBLE_MASTER_KEY
$masterKey = $null
```

## 8. Deploy

```powershell
npm run build:client
npx wrangler deploy --config deploy\cloudflare\wrangler.local.jsonc
```

## 9. Verify

1. Open `https://db.example.com`.
2. Sign in through the configured identity provider.
3. Seed the tiny store.
4. Confirm `/api/config` returns provider `r2`.
5. Confirm private object GETs use `/api/objects/scopes/...`.
6. Confirm raw object bodies start with `TDB1` and contain no plaintext JSON.
7. Confirm a second HEAD request returns 304.
8. Confirm the browser key is non-extractable.
9. Confirm logout revokes the session and blocks brokered reads.

The reference conformance run verified all nine checks, plus retained
delete/restore, administrator user listing, maintenance-mode write blocking,
and trie-to-snapshot migration.

## 10. Operations

Monitor:

- Worker CPU time and errors
- R2 Class A writes
- R2 Class B reads
- conditional-write conflicts
- envelope bytes before and after gzip
- key-grant counts
- garbage-collection object counts

Add R2 lifecycle rules for abandoned key versions and benchmark prefixes only
after retention requirements are defined. Configure the private auth bucket to
expire objects below `auth-v1/sessions/` and `auth-v1/rate-limits/` after the
maximum operational retention period:

```powershell
npx wrangler r2 bucket lifecycle set <auth-bucket-name> `
  --file deploy\cloudflare\auth-lifecycle.example.json
```

## References

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Use R2 from Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [Workers static asset bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
