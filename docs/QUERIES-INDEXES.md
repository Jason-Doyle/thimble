# Queries and secondary indexes

ThimbleDB supports bounded document queries inside one scope and one
collection. It does not provide SQL, joins, aggregates, cross-scope queries,
or automatic indexes for every field.

## Typed collection

Define the document parser and the indexes the authority should maintain:

```ts
import {
  collectionIndexConfiguration,
  defineCollection,
  defineIndex,
} from "thimbledb";

type Note = {
  id: string;
  title: string;
  body: string;
  lastModified: number;
};

const noteSchema = {
  parse(value: unknown): Note {
    // Use Zod or another parser in a real application.
    return value as Note;
  },
};

export const notes = defineCollection("notes", noteSchema, {
  indexes: [
    defineIndex<Note>("by-title", ["title"]),
    defineIndex<Note>(
      "by-last-modified",
      ["lastModified"],
      "range",
      {
        include: ["title"],
      },
    ),
  ],
});

export const collectionIndexes =
  collectionIndexConfiguration([notes]);
```

The parser uses the same structural `parse(value)` contract as Zod. ThimbleDB
does not require Zod as a runtime dependency.

## Configure the authority

Cloudflare:

```ts
import {
  createCloudflareAuthority,
} from "thimbledb/authority/cloudflare";
import { collectionIndexes } from "./collections";

export default createCloudflareAuthority({
  collectionLayouts: {
    notes: "snapshot",
  },
  collectionIndexes,
});
```

Node:

```ts
import {
  startNodeAuthority,
} from "thimbledb/authority/node";
import { collectionIndexes } from "./collections";

await startNodeAuthority({
  collectionLayouts: {
    notes: "snapshot",
  },
  collectionIndexes,
});
```

Environment-only deployments can set the same configuration as JSON:

```powershell
$env:THIMBLE_COLLECTION_INDEXES = '{"notes":[{"name":"by-title","fields":["title"],"mode":"equality"},{"name":"by-last-modified","fields":["lastModified"],"mode":"range"}]}'
```

Code configuration is easier to review and type-check.

## Fluent query

```ts
const db = await createThimbleClient();
const noteCollection = db.collection(notes);

const result = await noteCollection
  .where((note) => note.title.eq("abc"))
  .orderBy((note) => note.lastModified.asc())
  .take(25)
  .get();

console.log(result.plan);       // "index"
console.log(result.indexName);  // "by-title"
console.log(result.documents);
```

The callback builds a serialisable query expression. ThimbleDB does not parse
or execute arbitrary JavaScript on the authority.

Supported expressions:

- `eq`
- `ne`
- `lt`
- `lte`
- `gt`
- `gte`
- `in`
- `contains` for strings and arrays
- boolean `and`, `or`, and `not` through the versioned query AST
- up to four ordering fields
- a result limit from 1 to 1,000

ID equality uses a direct document read. On a cold cache miss, an authority
with read bundles enabled can satisfy it with one bounded browser request.

## Local predicates

An arbitrary JavaScript predicate can only run after documents are loaded:

```ts
const urgent = await noteCollection.filter(
  (note) => note.title.startsWith("Urgent"),
  500,
);
```

`filter` is explicitly local and requires a maximum collection size. It cannot
use a secondary index.

## How indexes are stored

Each configured index is an encrypted immutable index page. The page maps
canonical scalar values to sorted document IDs.

The collection HEAD references:

- the active snapshot or trie root
- every active secondary index hash
- one collection revision

Documents and indexes become visible through the same conditional HEAD
update. A stale writer cannot publish a document root without the matching
index roots.

Failed conditional writes may leave unreachable immutable objects. Quiescent
retention maintenance removes them later.

## Equality, range, and composite indexes

Equality index:

```ts
defineIndex<Note>("by-title", ["title"]);
```

Range index:

```ts
defineIndex<Note>(
  "by-last-modified",
  ["lastModified"],
  "range",
);
```

Composite equality index:

```ts
defineIndex<Note>(
  "by-owner-status",
  ["ownerId", "status"],
);
```

Range indexes contain exactly one field. Equality indexes can contain up to
four fields.

Only scalar string, number, boolean, or null values are indexed. Arrays and
objects remain available to bounded local filtering.

## Explicit covering fields

An index can include up to eight additional document fields:

```ts
defineIndex<Note>(
  "by-title",
  ["title"],
  "equality",
  {
    include: ["body", "lastModified"],
  },
);
```

Use an explicit typed projection to opt into the covering path:

```ts
const noteCardSchema = {
  parse(value: unknown): Pick<
    Note,
    "id" | "title" | "body" | "lastModified"
  > {
    // Validate with Zod or another schema in a real application.
    return value as Pick<
      Note,
      "id" | "title" | "body" | "lastModified"
    >;
  },
};

const cards = await notes
  .where((note) => note.title.eq("abc"))
  .orderBy((note) => note.lastModified.desc())
  .take(25)
  .select(
    ["title", "body", "lastModified"],
    noteCardSchema,
  )
  .get();
```

The result documents contain `id` and the selected fields. The index can
answer the query without full-document reads only when all predicate,
ordering, and selected fields are either index key fields or declared
`include` fields.

The projection schema is required even when the index covers the query.
ThimbleDB does not cast unvalidated index values to the application type.
Zod-compatible `parse(value)` schemas work without adding Zod as a ThimbleDB
runtime dependency.

Each stored covering projection is limited to 64 KiB decoded. A write fails
explicitly if the declared fields exceed that bound; choose smaller list-view
fields instead of including large bodies or binary-like JSON values.

The complete immutable index page is limited to 4 MiB decoded. Index pages are
built and checked before changed document objects are written. Oversized
definitions fail with `413 secondary_index_too_large`.

ThimbleDB loads complete documents when:

- `.select(...)` is not used
- any selected field is not covered
- any predicate field is not covered
- any ordering field is not covered
- the active index page predates or disagrees with the covering definition

This preserves schema validation and full-document behaviour for existing
queries. Adding or changing `include` fields is an index-definition change and
requires the explicit index rebuild process.

## Query plans

Inspect the planned operation before running it:

```ts
const query = noteCollection
  .where((note) => note.title.eq("abc"))
  .take(25);

console.log(query.explain());
```

Plans are:

- `point`: direct ID read
- `index`: configured secondary index candidate lookup
- `scan`: bounded collection scan

Index candidates are still checked against the full query after their
documents are read.

## Existing collections

Adding an index changes the authority layout generation. Existing browsers
must reload.

Removing an active index or changing its definition requires the explicit
index migration. Ordinary writes and other maintenance operations fail closed
when the configured definitions omit or disagree with an index referenced by
the current collection HEAD.

Rebuild indexes during maintenance:

```powershell
$env:THIMBLE_MIGRATION_QUIESCENT = "true"
$env:THIMBLE_SCOPE_ID = "user:<id>"
$env:THIMBLE_COLLECTIONS = "notes"
$env:THIMBLE_COLLECTION_LAYOUTS = "notes=snapshot"
$env:THIMBLE_COLLECTION_INDEXES = '{"notes":[{"name":"by-title","fields":["title"],"mode":"equality"}]}'
npx thimbledb rebuild-indexes
```

The migration exports and rewrites the same stored records, rebuilds indexes,
and verifies document equality.

If an index is configured but has not been built yet, queries fall back to the
bounded scan plan.

## Deliberate limits

Secondary indexes do not turn ThimbleDB into Cosmos DB, PostgreSQL, or another
general query engine.

ThimbleDB does not provide:

- automatic indexing of every field
- joins
- aggregates
- cross-collection or cross-scope queries
- distributed transactions
- arbitrary server-side JavaScript
- unrestricted regular expressions
- full-text or vector search

Choose a full database when those capabilities are central to the
application.
