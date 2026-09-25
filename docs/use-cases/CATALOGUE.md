# Small catalogue or reference library

Use ThimbleDB for product metadata, service catalogues, policy libraries,
training material, or documentation indexes that are read often and changed
occasionally.

## Workload assumptions

- The collection remains bounded.
- Reads are direct by ID or full/filtered scans.
- Search ranking and full-text indexing are not required.
- Writes are occasional and validated by the authority.
- Cold-read latency of one or more broker requests is acceptable.

## Why it fits

Immutable snapshots provide one content object for a small collection scan.
Trie layout reduces write amplification and point-read bytes as collections
grow. The layout advisor provides a documented starting recommendation, while
migration remains an explicit maintenance operation.

## When not to use it

Choose a search or relational system when the application requires:

- full-text relevance
- faceting across a large catalogue
- complex joins
- large aggregate reports
- high-frequency shared stock counters

## Suggested model

```ts
type CatalogueItem = {
  id: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  active: boolean;
  updatedAt: string;
};
```

Start with snapshot when the compressed collection is small, scans are common,
and writes are infrequent. Use trie when point reads dominate or writes become
more frequent.

```ts
const items = await db.scan("catalogue");
const activeTraining = items.filter(
  (item) =>
    item.active === true &&
    item.category === "training",
);
```

This filtering runs over the bounded client-side scan. It is not an indexed
query.

## Scaffold prompt

```text
Build a small catalogue or reference library with ThimbleDB 3.x.

Model JSON documents with stable IDs, category, summary, tags, active status,
and update timestamp. Start with snapshot layout and use a 10-second HEAD TTL.
Use bounded client-side filtering for category and tags. Add the layout advisor
inputs and document when trie migration becomes appropriate.

Do not add SQL, an ORM, full-text search, faceting, or a high-frequency stock
counter. Add tests for cold and warm reads, scan filtering, write validation,
delete/restore, stale layout rejection, and exact layout migration.
```

## Validation checklist

- Collection size and average document bytes are measured.
- Layout advice records reasons and confidence.
- Scan filters remain bounded and deterministic.
- Authority validation rejects malformed records.
- Delete and restore preserve the configured retention policy.
- Layout migration runs only in maintenance mode.
- Stale tabs reload before reading a retired layout.
