# Per-user workspace and drafts

Use ThimbleDB for personal notes, saved items, preferences, drafts, and
workflow state that belong to one signed-in user.

## Workload assumptions

- Each record belongs to one internal user UUID.
- Direct reads and small collection scans are sufficient.
- Writes occur during explicit saves rather than continuous collaboration.
- Previously loaded data should remain readable when the network is
  unavailable.
- Writes can wait until the browser reconnects.

## Why it fits

The authority maps every accepted OIDC identity to a stable internal UUID.
Records stored in `user:<uuid>` remain attached to that user when identities
are linked or provider usernames change.

Memory and encrypted IndexedDB caches reduce repeat reads. Tombstones provide
delete and restore behaviour without immediately removing encrypted history.

## When not to use it

Choose another data layer when drafts require:

- live multi-user editing
- offline write queues and merge resolution
- full-text search across a large archive
- relational references that must update atomically

## Suggested collections

| Collection | ID | Starting layout | Notes |
| --- | --- | --- | --- |
| `profile` | `current` | Snapshot | One small user profile |
| `preferences` | feature or section key | Snapshot | Small and read frequently |
| `drafts` | UUID | Snapshot, then trie if measured size grows | Explicit save operations |
| `saved-items` | source record ID | Trie | Direct ID reads and incremental growth |

All collections use the user's default `user:<uuid>` scope.

## Minimal browser usage

Assume `db` is created from the authority configuration as shown in the
[Quickstart](../QUICKSTART.md).

```ts
await db.write("drafts", "draft-123", {
  id: "draft-123",
  title: "Release notes",
  body: "Initial draft",
  updatedAt: new Date().toISOString(),
});

const draft = await db.get("drafts", "draft-123");
const drafts = await db.scan("drafts");

await db.delete("drafts", "draft-123");
await db.restore("drafts", "draft-123");
```

Do not put provider access tokens, secrets, or extracted scope keys in a
document.

## Retention

Use the default 30-day restore window and seven-day purge grace unless the
application has a different published policy. An account-erasure workflow can
tombstone every user collection through the administrator scope-erasure API.

## Scaffold prompt

```text
Add a per-user workspace to this application using ThimbleDB 3.x.

Store profile, preferences, drafts, and saved items in the signed-in user's
`user:<uuid>` scope. Use snapshot layout for profile and preferences. Start
drafts as snapshot and saved items as trie. Use the documented authority
configuration, OIDC session exchange, encrypted IndexedDB cache, layout
generation checks, delete, restore, and logout handling.

Do not add local passwords, offline write queues, full-text search, or
cross-user scans. Add tests proving that two users cannot read each other's
workspace, deleted drafts are hidden, restoration works, and logout clears the
local cache.
```

## Validation checklist

- Two provider identities mapped to different users receive different scopes.
- Linking a second identity retains the same workspace.
- A cold read succeeds through the broker.
- A repeated read uses memory or IndexedDB.
- Deleted drafts disappear from get and scan.
- Restore works inside the retention window.
- Logout blocks later reads and clears cached values.
- No provider or storage credential appears in browser storage.
