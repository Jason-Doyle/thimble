# Operations

## Required secrets

| Secret | Purpose | Rotation effect |
| --- | --- | --- |
| `THIMBLE_MASTER_KEY` | Derives scope encryption and address keys | Requires planned data re-encryption if changed |
| `THIMBLE_PASSWORD_PEPPER` | Defends local password hashes if the auth store leaks | Requires password reset to replace |
| Provider write credential | Lets the authority mutate object storage | No stored-data rewrite |

Back up the deployment master key through the cloud secret manager's supported
process. Losing it makes encrypted scopes unrecoverable.

## Key rotation

Normal scope rotation:

1. Set `THIMBLE_KEY_VERSION` to the new write version.
2. Add the previous version to `THIMBLE_READ_KEY_VERSIONS`.
3. Restart authorities so browsers receive both readable keys.
4. Rewrite each live collection:

```powershell
$env:THIMBLE_SCOPE_ID = "user:<id>"
$env:THIMBLE_KEY_VERSION = "2"
$env:THIMBLE_READ_KEY_VERSIONS = "1"
$env:THIMBLE_COLLECTIONS = "products,orders,settings"
npm run migrate:keys
```

The migration compares the collection HEAD it scanned with the HEAD it commits.
It aborts without replacing HEAD if a concurrent write wins. Re-run the
collection after writes are quiescent. Verification reads the rewritten
collection using only the current key and compares full content.

5. Verify application reads and collection content.
6. Retain the old version for the required rollback window.
7. Remove the old version from `THIMBLE_READ_KEY_VERSIONS`.
8. Remove unreachable old objects only through a safe offline maintenance
   process.

The migration is idempotent per collection and rewrites the live trie under the
current write key. It does not delete historical objects.

## Backup

Object storage durability is not a logical backup. Enable:

- R2 object lifecycle appropriate to the application
- Azure blob versioning or soft delete
- S3 versioning
- periodic exported collection snapshots

Backups require the matching master key version.

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
  its immediate proxy. Account and external-subject limits still apply.

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

Leaked password pepper:

1. Preserve evidence and stop public login traffic.
2. Replace the pepper.
3. Require password resets because existing hashes cannot be re-peppered
   without plaintext passwords.
4. Revoke every active session.

## Cleanup

Garbage collection must not delete nodes reachable by a stale writer or reader.
Destructive garbage collection is disabled in production engines. The
benchmark can enable a quiescent-only mode explicitly. A future online
collector needs generation retention, grace periods, or reader leases before
deletion.
