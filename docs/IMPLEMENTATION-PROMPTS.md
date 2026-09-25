# Implementation prompts

Replace bracketed values, then paste the complete prompt into the coding tool
you use. These prompts describe required behaviour and guardrails; they do not
grant the tool access to cloud credentials or production secrets.

## Integrate ThimbleDB into an existing web application

```text
Integrate ThimbleDB 1.x into this existing TypeScript web application.

Application context:
- Framework: [framework]
- Package manager: [package manager]
- OIDC provider: [Entra/Auth0/other]
- Authority platform: [Cloudflare/Node]
- Collections: [collection list]
- Scope model: [per-user/per-tenant/both]

Requirements:
1. Inspect the repository and follow its existing patterns before changing files.
2. Install `thimbledb` and use only documented public exports.
3. Use external OIDC authentication. Do not add local passwords, password hashes, recovery tokens, passkey storage, or MFA secrets to ThimbleDB.
4. Exchange the provider access token at `/api/auth/oidc/<provider>/session`.
5. Build the browser client from `/api/config` and the scope key grant.
6. Keep provider credentials and object-storage credentials server-side.
7. Keep scope keys memory-only as non-extractable CryptoKeys.
8. Pass `collectionLayouts`, `layoutGeneration`, and `configurationUrl` to `ThimbleClient`.
9. Preserve CSRF and `x-thimble-layout-generation` headers on mutations.
10. Add typed helpers for get, scan, write, delete, restore, and logout.
11. Add tests for authentication failure, scope isolation, stale layout generation, deletion/restore, and logout cache clearing.
12. Update the application's setup documentation with non-secret configuration only.

Do not expose R2/S3/Blob directly to the browser. Do not auto-link identities by email. Do not use undocumented package internals.

Run the smallest applicable tests, type-check, and production build. Report exact validation results and any remaining provider configuration that must be completed manually.
```

## Deploy the Cloudflare authority

```text
Deploy ThimbleDB 1.x as a Cloudflare Worker with private R2 storage.

Inputs:
- Worker name: [name]
- Custom domain: [db.example.com]
- Browser application origin: [https://app.example.com]
- Data bucket: [bucket]
- Auth bucket: [bucket]
- OIDC provider: [Entra/generic]
- Required scope: [scope]
- Required role: [role]

Requirements:
1. Import the authority from `thimbledb/authority/cloudflare`.
2. Use separate private R2 bindings named `DB` and `AUTH_DB`.
3. Keep all bucket custom-domain and public-access settings disabled.
4. Configure the exact allowed browser origin.
5. Require at least one OIDC scope or role.
6. Store `THIMBLE_MASTER_KEY` with `wrangler secret put`; never write it to source, output, or logs.
7. Configure 30-day deletion retention, 7-day purge grace, and maintenance mode off.
8. Apply lifecycle expiration only to auth sessions and rate-limit records.
9. Do not apply age-based deletion to application data objects.
10. Keep bindings, routes, and infrastructure placeholders disabled until real values are supplied.
11. Deploy, then verify session exchange, encrypted object reads, conditional HEAD, write, delete, restore, logout revocation, and stale layout rejection.

Do not invent account IDs, bucket names, tenant IDs, audiences, routes, or secrets. Stop and report any missing non-secret value instead of deploying a placeholder.
```

## Deploy the Node authority

```text
Add the ThimbleDB Node authority to this deployment.

Target:
- Host platform: [Docker/Azure Container Apps/AWS Lambda/other]
- Storage provider: [local/Azure Blob/S3/R2]
- Public origin: [origin]
- OIDC provider: [provider]

Requirements:
1. Define typed collections and any required indexes in one shared module.
2. Import `startNodeAuthority` from `thimbledb/authority/node`.
3. Install `@azure/storage-blob` for Azure or `@aws-sdk/client-s3` for S3/R2.
4. Configure separate data and auth stores.
5. Use secure cookies outside local development.
6. Configure the exact allowed origin and trusted proxy boundary.
7. Ignore caller-supplied forwarding headers unless the immediate proxy is explicitly trusted.
8. If source IP cannot be verified, disable IP limits and retain subject limits.
9. Keep the master key and provider credentials in the platform secret store.
10. Expose only the authority HTTP port.
11. Add health, authentication, indexed query, write, deletion, and logout smoke tests.
12. Document backup, logical export, key rotation, retention maintenance, index migration, and layout migration.

Do not create a second authentication system. Do not store passwords or provider access tokens.
For machine access, prefer an OIDC service principal with explicit roles. Do
not add a static database-wide admin key.
```

Repository starting points:

- Node:
  `https://github.com/Jason-Doyle/thimbledb-node-starter`
- Cloudflare:
  `https://github.com/Jason-Doyle/thimbledb-cloudflare-starter`

Use the repository as a template, preserve its security boundaries, and
replace only the application model, identity configuration, and provider
resources required by the target deployment.

## Add the packaged Studio

```text
Enable ThimbleDB Studio on this authority.

Requirements:
1. Use the Studio assets and APIs from the installed thimbledb package.
2. Mount the frontend at /studio/.
3. Configure an exact Studio origin.
4. Keep Studio read-only until the operator explicitly unlocks writes.
5. Never give thimble.admin implicit access to an ungranted data scope.
6. Keep object-storage credentials and server encryption keys out of browser code.
7. Validate collection discovery, bounded queries, editing, delete and restore, export, and index health.
```

## Design collections and choose layouts

```text
Design the ThimbleDB collections for this application.

Domain:
[describe records, ownership, expected counts, read patterns, scan patterns, write frequency, and concurrent writers]

Requirements:
1. Assign every collection to one user, tenant, role, or public scope.
2. Avoid cross-scope queries and relational joins.
3. Use document IDs for direct point reads.
4. Estimate document count, average document bytes, point-read ratio, scan ratio, writes per minute, and concurrent writers.
5. Run `recommendCollectionLayout` or `npm run advise:layout`.
6. Prefer snapshot for small, mostly idle, scan-heavy collections.
7. Prefer trie for larger point-read-heavy collections or concurrent writers.
8. Keep the recommendation advisory. Do not migrate automatically.
9. Plan retained deletion and restoration for every user-owned collection.
10. Identify filters that may require explicit derived indexes later.

Return a table with collection, scope, ID strategy, expected size, access pattern, recommended layout, confidence, and reasons.
```

## Migrate a collection layout safely

```text
Migrate ThimbleDB collection [collection] in scope [scope] from [trie/snapshot] to [snapshot/trie].

Requirements:
1. Confirm every authority is in `THIMBLE_MAINTENANCE_MODE=true`.
2. Confirm normal writes return `503 maintenance_mode`.
3. Confirm there are no retained tombstones in the collection.
4. Export every stored record, including internal tombstones.
5. Replace the target layout exactly; do not merge with stale target records.
6. Verify full stored-record equality through a current-key-only reader.
7. Add the target to `THIMBLE_COLLECTION_LAYOUTS`.
8. Add the source to `THIMBLE_RETIRED_COLLECTION_LAYOUTS`.
9. Deploy the new layout generation and disable maintenance mode.
10. Verify stale clients receive `409 layout_changed` and reload.
11. Keep the retired layout until the rollback and retention windows expire.

Do not delete the source layout during migration. Do not continue after a failed equality check.
```

## Review a ThimbleDB integration

```text
Review this ThimbleDB integration for high-confidence correctness and security defects.

Check:
- OIDC issuer, audience, expiry, scope, role, tenant, and signature validation
- identity-linking proof, collision handling, and final-identity protection
- administrator role enforcement and session revocation
- exact Origin, JSON content type, and CSRF enforcement
- scope grant checks on object reads, key grants, writes, deletion, and restore
- master key, provider credentials, tokens, and scope-key handling
- non-extractable browser keys and encrypted IndexedDB values
- cache clearing and cross-tab logout
- layout-generation checks on reads and mutations
- exact layout migration, retained tombstones, and retired-layout cleanup
- compare-and-swap semantics for mutable HEAD objects
- trusted proxy and source-IP handling
- provider lifecycle rules and backup compatibility

Ignore style-only findings. Report severity, file, lines, impact, confidence, and the smallest safe fix. Do not create a review report file unless explicitly requested.
```
