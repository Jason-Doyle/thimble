# Operations

## Required secrets

| Secret | Purpose | Rotation effect |
| --- | --- | --- |
| `THIMBLE_MASTER_KEY` | Derives scope encryption and address keys | Requires planned data re-encryption if changed |
| Provider write credential | Lets the authority mutate object storage | No stored-data rewrite |

Back up the deployment master key through the cloud secret manager's supported
process. Losing it makes encrypted scopes unrecoverable.

## External-only authentication upgrade

Before deploying this version over an installation that used local password
accounts, run:

```powershell
npm run migrate:external-auth
```

Use the same provider and auth-store environment variables as the authority.
The command preserves internal user UUIDs and their data scopes, removes
password material and local identity indexes, revokes every legacy session,
and disables mappings that do not already contain an external identity.

## Key rotation

Normal scope rotation:

1. Set `THIMBLE_KEY_VERSION` to the new write version.
2. Add the previous version to `THIMBLE_READ_KEY_VERSIONS`.
3. Put every authority into `THIMBLE_MAINTENANCE_MODE=true`.
4. Restart authorities so reads receive both versions and writes are blocked.
5. Rewrite each live collection:

```powershell
$env:THIMBLE_SCOPE_ID = "user:<id>"
$env:THIMBLE_KEY_VERSION = "2"
$env:THIMBLE_READ_KEY_VERSIONS = "1"
$env:THIMBLE_COLLECTIONS = "products,orders,settings"
$env:THIMBLE_COLLECTION_LAYOUTS = "products=snapshot"
$env:THIMBLE_MIGRATION_QUIESCENT = "true"
npm run migrate:keys
```

The migration rewrites every reachable stored record in the configured active
layout, including retained tombstones. Verification reads the active layout
using only the current key and compares full stored content.

6. Verify application reads and collection content.
7. Disable maintenance mode.
8. Retain the old version for the required rollback window.
9. Remove the old version from `THIMBLE_READ_KEY_VERSIONS`.
10. Remove unreachable old objects only through a safe offline maintenance
   process.

The migration is idempotent per collection and rewrites the live trie under the
current write key. It does not delete historical objects.

## Collection layout changes

Use `npm run advise:layout` to record a recommendation. To apply one:

1. Put every authority into `THIMBLE_MAINTENANCE_MODE=true`.
2. Confirm normal writes return `503 maintenance_mode`.
3. Ensure the collection has no retained tombstones.
4. Run `npm run migrate:layout`, or use the administrator migration endpoint.
5. Add `collection=snapshot` or `collection=trie` to
   `THIMBLE_COLLECTION_LAYOUTS`.
6. Disable maintenance mode and verify browser reads.

The migration verifies full document equality and leaves the old layout in
place for rollback.

## Secondary index changes

Adding or changing a declared index changes the layout generation. Put every
authority into maintenance mode, block writes, and rebuild the configured
indexes:

```powershell
$env:THIMBLE_MIGRATION_QUIESCENT = "true"
$env:THIMBLE_SCOPE_ID = "user:<id>"
$env:THIMBLE_COLLECTIONS = "notes"
$env:THIMBLE_COLLECTION_LAYOUTS = "notes=snapshot"
$env:THIMBLE_COLLECTION_INDEXES = '{"notes":[{"name":"by-title","fields":["title"],"mode":"equality"}]}'
npx thimbledb rebuild-indexes
```

The operation rewrites the same stored records, publishes index references
through the collection HEAD, and verifies full document equality.

Other rewrite operations preserve the complete active index definition set
and fail if `THIMBLE_COLLECTION_INDEXES` is absent, partial, or mismatched.
Use the explicit index migration when removing or redefining an index.

See [Queries and secondary indexes](QUERIES-INDEXES.md).

Studio can inspect index health and apply the configured index set while the
authority is in maintenance mode. The caller still needs explicit write
access to the selected scope. See [ThimbleDB Studio](STUDIO.md).

After upgrading a pre-version-3 deployment, run `npx thimbledb
migrate-metadata` for each scope while writes are blocked. This adds the
authenticated bounds required by Studio and bounded scan queries.

## Retention maintenance

Document and scope erasure use a 30-day restore window and seven-day purge
grace by default. Physical collection is a separate quiescent operation:

```powershell
$env:THIMBLE_MAINTENANCE_QUIESCENT = "true"
$env:THIMBLE_SCOPE_ID = "user:<id>"
$env:THIMBLE_COLLECTIONS = "products,customers,orders"
$env:THIMBLE_COLLECTION_LAYOUTS = "products=snapshot,customers=snapshot"
npm run maintain:retention
```

Do not run this while any authority can write or while the rollback window
still requires old immutable generations.

## Backup

Object storage durability is not a logical backup. Enable:

- R2 object lifecycle appropriate to the application
- Azure blob versioning or soft delete
- S3 versioning
- periodic exported collection snapshots

Backups require the matching master key version.

Logical exports are portable plaintext migrations, not encrypted backups. See
[Logical migration](MIGRATION.md).

## Observability

Record:

- read source: memory, IndexedDB, or remote
- remote object bytes
- compression ratio
- envelope encode/decode duration
- HEAD conditional-write retries
- key-grant latency and failures
- garbage-collection candidates and deletes
- provider operation counts and cost class

Never log scope keys, raw session cookies, SAS tokens, connection strings, or
decrypted document bodies.

## Source-IP rate limiting

The Node authority uses the direct socket peer by default and ignores
caller-controlled forwarding headers.

- AWS Lambda Web Adapter deployments use the trusted
  `x-amzn-request-context` source address.
- A self-hosted reverse proxy can be listed in
  `THIMBLE_TRUSTED_PROXY_IPS`. Forwarding chains are evaluated from right to
  left, skipping only configured trusted peers.
- Set `THIMBLE_DISABLE_IP_RATE_LIMIT=true` when the deployment cannot verify
  its immediate proxy. External-subject limits still apply.

Do not enable forwarding-header trust merely to obtain a more specific address.
An incorrect proxy boundary lets callers rotate spoofed addresses.

## Incident response

Leaked session cookie:

1. Revoke the server-side session.
2. Review object and key-grant request logs.
3. Rotate affected scope keys if key grants may also have been exposed.

Leaked scope key:

1. Stop granting the key.
2. Increment the scope key version.
3. Re-encrypt live data.
4. Remove old encrypted objects after required retention.

Leaked master key:

1. Treat every derived scope key as exposed.
2. Freeze writes.
3. Introduce a new master key.
4. Re-encrypt all live scopes.
5. Revoke all sessions.

## Cleanup

Garbage collection must not delete nodes reachable by a stale writer or reader.
Destructive garbage collection is disabled in production engines. The
benchmark can enable a quiescent-only mode explicitly. A future online
collector needs generation retention, grace periods, or reader leases before
deletion.
