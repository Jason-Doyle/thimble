# Progress, training, or activity journal

Use ThimbleDB for milestones, session notes, structured observations, and
user-owned progress history.

## Workload assumptions

- One user owns each journal.
- Entries are structured JSON, not large documents or media.
- New entries and corrections are occasional.
- The UI reads recent entries often.
- Aggregate analytics are optional and can be derived elsewhere.

## Why it fits

User scopes keep journals physically separated. Trie layout supports direct
reads and incremental entry growth. Snapshot collections work for the user
profile, goals, or a small summary record.

Retained deletion supports recovery from an accidental removal. External
identity linking allows the same user to keep one journal when changing login
providers.

## Suggested collections

| Collection | Starting layout | Notes |
| --- | --- | --- |
| `profile` | Snapshot | Goals and current summary |
| `sessions` | Trie | One record per session |
| `milestones` | Trie | Direct ID reads |
| `templates` | Snapshot | Small reusable prompts or forms |

Keep leaderboards, population analytics, and cross-user comparisons in a
separate derived system.

## Minimal entry

```ts
await db.write("sessions", "session-2026-09-24", {
  id: "session-2026-09-24",
  occurredAt: "2026-09-24T18:00:00.000Z",
  category: "practice",
  observations: ["Improved consistency"],
  nextActions: ["Repeat the same exercise"],
});
```

## Scaffold prompt

```text
Build a private progress journal with ThimbleDB 1.x.

Store profile and templates as snapshots. Store sessions and milestones as
tries in the signed-in user's `user:<uuid>` scope. Use stable IDs, structured
observations, explicit timestamps, retained deletion, and restore.

Do not add cross-user scans, public leaderboards, full-text search, local
passwords, or large media in JSON records. Add tests for user isolation,
identity linking, recent-entry reads, corrections, delete/restore, account
disablement, and scope erasure.
```

## Validation checklist

- Journal data always uses the internal user scope.
- A linked identity resolves to the same journal.
- A different user cannot fetch the journal key or objects.
- Recent entries use cached reads after first load.
- Deleted entries are hidden immediately.
- User erasure covers every documented journal collection.
- Cross-user analytics use a separate pipeline.
