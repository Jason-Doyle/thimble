# Deletion and retention

ThimbleDB uses retained logical deletion before physical collection.

## Document lifecycle

1. `DELETE /api/collections/:collection/documents/:id` replaces the live
   document with an encrypted tombstone.
2. Reads and scans hide the tombstone immediately.
3. The original document remains inside the tombstone for the configured
   restore window, 30 days by default.
4. `POST .../:id/restore` restores the document before that window expires.
5. A further grace period, seven days by default, must pass before the
   tombstone can leave the current live layout.
6. Physical deletion of unreachable immutable objects occurs only during an
   explicitly quiescent maintenance run.

The reserved field `__thimbleTombstone` cannot be supplied by application
documents.

## Scope erasure

An administrator can tombstone every live document in selected collections
for a `user:<uuid>` or `tenant:<id>` scope:

```text
POST /api/admin/scopes/<scope>/erase
```

The request body lists collection names. This preserves the same restore and
grace periods as individual deletion. It is suitable for account or tenant
erasure workflows that require a short recovery window.

Expired tombstones can be removed from the live layout with:

```text
POST /api/admin/scopes/<scope>/purge-deleted
```

This operation does not delete old immutable generations.

## Physical collection

After all authorities are in maintenance mode and no stale readers or writers
remain:

```powershell
$env:THIMBLE_MAINTENANCE_QUIESCENT = "true"
$env:THIMBLE_SCOPE_ID = "user:<uuid>"
$env:THIMBLE_COLLECTIONS = "products,customers,orders"
$env:THIMBLE_COLLECTION_LAYOUTS = "products=snapshot,customers=snapshot"
$env:THIMBLE_RETIRED_COLLECTION_LAYOUTS = "products=trie,customers=trie"
npm run maintain:retention
```

The command:

- removes tombstones whose restore and grace periods have elapsed
- deletes trie nodes unreachable from current HEAD
- deletes immutable snapshots not referenced by current HEAD
- drops explicitly retired layout prefixes after their rollback window

It refuses to run without the explicit quiescent flag. Data-bucket lifecycle
rules must not delete content generations independently because object storage
cannot determine live reachability.

## Configuration

```text
THIMBLE_DELETE_RETENTION_DAYS=30
THIMBLE_DELETE_GRACE_DAYS=7
THIMBLE_MAINTENANCE_MODE=false
```

Auth-session and rate-limit lifecycle rules remain separate from application
content retention.
