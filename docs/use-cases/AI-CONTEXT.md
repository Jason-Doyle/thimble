# Structured context for an AI-assisted application

Use ThimbleDB for approved user preferences, tool settings, bounded source
summaries, task state, and user-controlled application memory.

## Workload assumptions

- Context is structured and intentionally selected.
- Records are bounded in count and size.
- The application reads a small working set repeatedly.
- The user can inspect and delete stored context.
- Semantic search and model training are separate concerns.

## Why it fits

Per-user scopes keep context attached to the internal user identity rather than
an email address or provider username. Browser caching makes the active working
set inexpensive to reread. Retained deletion provides a recovery window while
scope erasure supports account removal.

Identity linking allows a user to retain the same approved context across
multiple external login methods.

## What to store

- explicit preferences
- enabled tool settings
- approved source references
- bounded source summaries
- task checkpoints
- user-reviewed facts
- retention and provenance metadata

## What not to store

- raw access tokens or credentials
- hidden model reasoning
- unrestricted conversation transcripts
- large binary content
- vector indexes
- unreviewed personal inferences
- data copied from another user or tenant

## Suggested collections

| Collection | Starting layout | Notes |
| --- | --- | --- |
| `preferences` | Snapshot | Small, read on startup |
| `tools` | Snapshot | Enabled tools and settings |
| `sources` | Trie | Direct reads by source ID |
| `checkpoints` | Trie | Bounded task state |
| `approved-facts` | Trie | User-reviewed structured records |

## Minimal record

```ts
await db.write("approved-facts", "fact-123", {
  id: "fact-123",
  subject: "output-format",
  value: "Use concise Markdown",
  source: "user-confirmed",
  approvedAt: new Date().toISOString(),
});
```

The application should show stored context and provide delete and restore
controls. A model should not silently create permanent records.

## Scaffold prompt

```text
Add user-controlled structured context to this AI-assisted application with
ThimbleDB 3.x.

Use the signed-in user's scope. Store preferences and tool settings as
snapshots; sources, checkpoints, and approved facts as tries. Require explicit
user approval before creating durable facts. Record provenance and timestamps.
Add visible list, delete, restore, and account-erasure controls.

Do not store provider tokens, hidden reasoning, unrestricted transcripts,
vectors, unreviewed inferences, or another user's data. Add tests for scope
isolation, identity linking, explicit approval, deletion, restore, logout cache
clearing, and user erasure.
```

## Validation checklist

- Every durable fact has a documented source and approval state.
- Users can inspect all stored context.
- Models cannot write outside the authorised user or tenant scope.
- Deletion hides context immediately and restoration follows policy.
- Account erasure includes every context collection.
- Vector search and large source content remain outside ThimbleDB.
