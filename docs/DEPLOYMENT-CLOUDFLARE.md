# Deploy to Cloudflare

Cloudflare Workers and R2 are the reference ThimbleDB deployment.

The design uses:

- one Worker for static assets, writes, sessions, and scope-key grants
- one R2 bucket for immutable encrypted objects
- an R2 custom domain for direct browser reads
- Cloudflare Access in front of the application hostname

R2 Standard currently includes 10 GB-month storage, 1 million Class A
operations, 10 million Class B operations, and free egress each month.

## 1. Build

```powershell
npm install
npm run build:client
npm run build:worker
```

The dry-run Worker bundle should remain small enough for the Workers free
plan. Record its compressed size during release checks.

## 2. Authenticate Wrangler

```powershell
npx wrangler login
```

## 3. Create R2 storage

Choose a real bucket name:

```powershell
npx wrangler r2 bucket create <bucket-name>
```

Do not use Infrequent Access for the initial deployment. The R2 free tier
applies to Standard storage.

## 4. Configure custom domains

Use two hostnames:

```text
db.example.com     Worker and browser application
data.example.com   R2 encrypted object reads
```

Attach `data.example.com` as the R2 bucket custom domain. Public HTTP reads are
acceptable only because private scope bodies are encrypted and node addresses
are HMAC-derived. Public data is intentionally readable.

Apply an R2 CORS policy. Copy
`deploy/cloudflare/cors.example.json`, replace the local origin with
`https://db.example.com`, then run:

```powershell
npx wrangler r2 bucket cors set <bucket-name> --file <edited-cors-file>
npx wrangler r2 bucket cors list <bucket-name>
```

## 5. Create Wrangler configuration

Copy the disabled example beside the original so its relative paths remain
valid:

```powershell
Copy-Item deploy\cloudflare\wrangler.example.jsonc deploy\cloudflare\wrangler.local.jsonc
```

Edit `deploy\cloudflare\wrangler.local.jsonc`:

1. Uncomment the `r2_buckets` block.
2. Set the real bucket name.
3. Set `THIMBLE_READ_BASE_URL` to `https://data.example.com/demo`.
4. Uncomment the Worker custom-domain route.
5. Replace both example domains.

The example keeps bindings and routes commented so copying the repository
cannot deploy infrastructure accidentally.

## 6. Configure authentication

The included Worker demo session grants one configured scope to any request
that reaches the Worker when `THIMBLE_DEMO_MODE=true`.

For a private evaluation:

1. Protect `db.example.com` with Cloudflare Access.
2. Restrict Access to the intended testers.
3. Leave demo mode enabled only behind that Access policy.

For a product deployment, replace the demo session function with the
application's authenticated identity and scope authorisation. Do not treat
demo mode as application authentication.

## 7. Create secrets

Generate independent values:

```powershell
$masterKey = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
$sessionSecret = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Store them through Wrangler without writing them to a file:

```powershell
$masterKey | npx wrangler secret put THIMBLE_MASTER_KEY
$sessionSecret | npx wrangler secret put THIMBLE_SESSION_SECRET
$masterKey = $null
$sessionSecret = $null
```

## 8. Deploy

```powershell
npm run build:client
npx wrangler deploy --config deploy\cloudflare\wrangler.local.jsonc
```

## 9. Verify

1. Open `https://db.example.com`.
2. Seed the tiny store.
3. Confirm `/api/config` returns provider `r2`.
4. Confirm object GETs use `https://data.example.com/demo/scopes/...`.
5. Confirm raw object bodies start with `TDB1` and contain no plaintext JSON.
6. Confirm a second HEAD request returns 304.
7. Confirm the browser key is non-extractable.
8. Confirm removing Access permission blocks new key grants.

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
after retention requirements are defined.

## Private R2 alternative

R2 presigned URLs authorise one object and operation. Temporary credentials can
cover multiple operations and paths. Either can replace the encrypted public
custom-domain path, but both add a signing or credential-refresh step to the
browser client.

Keep the envelope encryption even when transport access is private. It
provides a separate confidentiality boundary and portable stored data.

## References

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Use R2 from Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [R2 presigned URLs and temporary credentials](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Workers static asset bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
