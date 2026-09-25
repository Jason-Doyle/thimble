# Offline-readable field guide and inspections

Use ThimbleDB for site instructions, asset details, inspection templates, and
previously loaded inspection records that should remain readable when a device
temporarily loses connectivity.

## Workload assumptions

- Guides and templates change infrequently.
- A worker reads a bounded subset of records in the field.
- Inspection writes occur only while connected.
- Records belong to one user or small tenant.
- Large media files use object storage outside ThimbleDB documents.

## Why it fits

The browser can retain decoded values in memory and encrypted values in
IndexedDB. When HEAD revalidation fails, cached data can be used as an offline
read fallback.

Snapshot layout reduces requests for small guide collections. Inspection
records can use trie when direct reads and incremental growth dominate.

## Important limitation

ThimbleDB does not queue offline mutations or merge concurrent edits. The UI
must show whether a write requires connectivity and must not display a local
save as durable until the authority confirms it.

## Suggested collections

| Collection | Starting layout | Notes |
| --- | --- | --- |
| `sites` | Snapshot | Small site directory |
| `assets` | Trie | Direct read by asset ID |
| `inspection-templates` | Snapshot | Read-heavy template set |
| `inspections` | Trie | Bounded structured records |

Keep photos, video, PDFs, and large attachments in their normal object store.
Store only metadata and authorised object references in ThimbleDB.

## Cache behaviour

Use content caching for guides and templates. Display the time of the last
successful HEAD check so users can distinguish current and cached data.

```ts
const template = await db.get(
  "inspection-templates",
  "daily-safety",
);
```

Handle a failed write as a failed write. Do not add a hidden local queue unless
the application also defines conflict and retry semantics.

## Scaffold prompt

```text
Build an offline-readable field guide and inspection workflow with ThimbleDB
3.x.

Use snapshot layout for sites and inspection templates, trie for assets and
inspection records, and content caching in the browser. Show last-checked time
and an explicit offline indicator. Allow cached reads while disconnected, but
disable or fail writes until the authority is reachable.

Store large media outside ThimbleDB and keep only metadata references. Add
tests for warm IndexedDB reads, offline read fallback, failed offline writes,
tenant isolation, delete/restore, and cache clearing on logout.
```

## Validation checklist

- Previously loaded guides remain readable without network access.
- Never-loaded records fail clearly while offline.
- Writes do not report success when the authority is unavailable.
- Cached data is encrypted in IndexedDB.
- Device cache keys differ from scope data keys.
- Logout removes field data and the device key for the scope.
- Large attachments are not embedded in JSON documents.
