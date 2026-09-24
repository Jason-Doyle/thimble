# Logical migration

ThimbleDB supports deterministic logical archives for moving application data
into or out of ThimbleDB.

Logical migration is separate from provider backup. A provider backup
preserves encrypted objects and requires the matching master key. A logical
archive contains portable plaintext documents.

## Security warning

Logical archives are not encrypted by default.

Treat an archive like a database export:

- write it to a protected local or encrypted volume
- do not commit it
- do not upload it as a public CI artifact
- remove it after the migration and verification window
- exclude provider tokens, passwords, session cookies, and master keys

Identity mappings and credentials are not included.

## Archive format

Version 1 archives are directories:

```text
archive/
  manifest.json
  collections/
    user%3A123--notes.ndjson
```

The manifest records:

- format and version
- creation time
- source package version
- scope IDs
- collection names
- document counts
- SHA-256 checksums
- whether retained tombstones are included

Collection files are deterministically ordered NDJSON.

## Export from ThimbleDB

```powershell
$env:THIMBLE_PROVIDER = "local"
$env:THIMBLE_SCOPE_ID = "user:<id>"
$env:THIMBLE_COLLECTION_LAYOUTS = "notes=snapshot"

npx thimbledb export `
  --scope "user:<id>" `
  --collections "notes,settings" `
  --out ".\private-export"
```

Add `--include-deleted` only when retained tombstones are required.

Validate the archive:

```powershell
npx thimbledb validate --archive ".\private-export"
```

## Import into ThimbleDB

Always dry-run first:

```powershell
npx thimbledb import `
  --archive ".\private-export" `
  --mode create `
  --dry-run
```

Write modes:

- `create`: target collections must be empty
- `replace`: archive contents replace the target collection exactly
- `merge`: source records replace matching IDs and retain other target records

Perform the write only after authorities are in maintenance mode:

```powershell
$env:THIMBLE_MIGRATION_QUIESCENT = "true"
npx thimbledb import `
  --archive ".\private-export" `
  --mode create
```

The importer reads the target back and compares full stored content.

The importer preflights every target collection before the first write.
Archive-wide import is not a cross-collection transaction, so keep authorities
quiescent and retain a provider backup until verification is complete.

An export reads a consistent HEAD for each collection independently. Block
writes while exporting when several collections must represent one
application-level point in time.

## JSON, CSV, and lowdb into ThimbleDB

JSON array:

```powershell
npx thimbledb ingest `
  --from json `
  --input ".\notes.json" `
  --scope "user:<id>" `
  --collection "notes" `
  --id-field "id" `
  --out ".\notes-archive"
```

Nested lowdb data:

```powershell
npx thimbledb ingest `
  --from lowdb `
  --input ".\db.json" `
  --path "data.notes" `
  --scope "user:<id>" `
  --collection "notes" `
  --out ".\notes-archive"
```

CSV:

```powershell
npx thimbledb ingest `
  --from csv `
  --input ".\notes.csv" `
  --scope "user:<id>" `
  --collection "notes" `
  --id-field "id" `
  --out ".\notes-archive"
```

CSV fields are imported as strings. Use JSON when types, arrays, or nested
objects must be preserved.

## SQLite into ThimbleDB

The source query is explicit:

```powershell
npx thimbledb ingest `
  --from sqlite `
  --input ".\app.sqlite" `
  --query "SELECT id, title, body, last_modified AS lastModified FROM notes" `
  --id-field "id" `
  --scope "user:<id>" `
  --collection "notes" `
  --out ".\notes-archive"
```

The SQLite adapter uses Node's built-in SQLite API, which is experimental in
Node.js 22.

## PostgreSQL into ThimbleDB

Install the optional adapter:

```powershell
npm install pg
```

Keep the connection string in an environment variable:

```powershell
$env:DATABASE_URL = "<private connection string>"

npx thimbledb ingest `
  --from postgres `
  --connection-env "DATABASE_URL" `
  --query "SELECT id, title, body, last_modified AS ""lastModified"" FROM notes" `
  --id-field "id" `
  --scope "user:<id>" `
  --collection "notes" `
  --out ".\notes-archive"
```

ThimbleDB does not infer joins, constraints, or relational ownership. The
query must return one JSON-compatible document per row.

## Firestore into ThimbleDB

Install the optional adapter:

```powershell
npm install @google-cloud/firestore
```

Use Application Default Credentials, then run:

```powershell
npx thimbledb ingest `
  --from firestore `
  --project-id "<project-id>" `
  --source-collection "notes" `
  --scope "user:<id>" `
  --collection "notes" `
  --out ".\notes-archive"
```

Collection groups and nested subcollections require separate explicit
migrations.

Firestore-specific values such as timestamps, references, and geopoints must
be mapped to plain JSON values before import.

## Emit data from an archive

JSON:

```powershell
npx thimbledb emit `
  --to json `
  --archive ".\private-export" `
  --scope "user:<id>" `
  --collection "notes" `
  --out ".\notes.json"
```

CSV and lowdb use `--to csv` or `--to lowdb`. lowdb also requires `--path`.

## PostgreSQL and SQLite target format

The default relational export is deliberately lossless:

| Column | Type |
| --- | --- |
| `scope_id` | text |
| `collection_name` | text |
| `document_id` | text |
| `document_json` | JSONB in PostgreSQL, JSON text in SQLite |

This preserves documents without pretending to infer a normalised schema.

PostgreSQL:

```powershell
npx thimbledb emit `
  --to postgres `
  --archive ".\private-export" `
  --connection-env "DATABASE_URL" `
  --table "thimbledb_documents" `
  --scope "user:<id>" `
  --collection "notes" `
  --mode create
```

SQLite:

```powershell
npx thimbledb emit `
  --to sqlite `
  --archive ".\private-export" `
  --out ".\export.sqlite" `
  --table "thimbledb_documents" `
  --scope "user:<id>" `
  --collection "notes"
```

## Firestore target

```powershell
npx thimbledb emit `
  --to firestore `
  --archive ".\private-export" `
  --project-id "<project-id>" `
  --target-collection "notes" `
  --scope "user:<id>" `
  --collection "notes" `
  --mode create
```

Use `replace` only when deleting every existing target document is intended.
Firestore writes are committed in batches of at most 500 documents and are
not one archive-wide transaction. Quiesce writers and retain a provider
backup until verification is complete.

## What migration does not infer

Migration tooling does not infer:

- relational joins
- foreign keys
- uniqueness constraints
- tenant ownership
- identity linking
- full-text indexes
- vector embeddings
- server-generated fields
- application validation rules

Mapping those concepts requires an application-specific migration plan.
