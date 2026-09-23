# Operations

## Required secrets

| Secret | Purpose | Rotation effect |
| --- | --- | --- |
| `THIMBLE_MASTER_KEY` | Derives scope encryption and address keys | Requires planned data re-encryption if changed |
| `THIMBLE_PASSWORD_PEPPER` | Defends local password hashes if the auth store leaks | Requires password reset to replace |
| Provider write credential | Lets the authority mutate object storage | No stored-data rewrite |
| Browser read credential | Lets a browser retrieve object bytes | No stored-data rewrite |

Back up the deployment master key through the cloud secret manager's supported
process. Losing it makes encrypted scopes unrecoverable.

## Key rotation

Normal scope rotation:

1. Increment `THIMBLE_KEY_VERSION`.
2. Keep the previous key version available for reads.
3. Write new objects with the new version.
4. Rewrite live HEAD trees in the background.
5. Verify no live object references the previous version.
6. Remove old objects according to retention policy.
7. Stop granting the previous key.

The POC currently derives one configured version and does not automate
multi-version migration.

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

## Incident response

Leaked browser read credential:

1. Revoke or expire it.
2. Issue a new credential.
3. Review object request logs.
4. Rotate scope keys only if plaintext keys were also exposed.

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
5. Revoke all sessions and read credentials.

Leaked password pepper:

1. Preserve evidence and stop public login traffic.
2. Replace the pepper.
3. Require password resets because existing hashes cannot be re-peppered
   without plaintext passwords.
4. Revoke every active session.

## Cleanup

Garbage collection must not delete nodes reachable by a stale writer or reader.
The current POC runs cleanup only when writes are quiescent. Production needs
generation retention, grace periods, or reader leases before deletion.
