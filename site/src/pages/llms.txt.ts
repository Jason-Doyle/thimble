import { site } from "../data/site";

export const prerender = true;

export function GET() {
  return text(`# ThimbleDB

> ${site.description}

ThimbleDB is an encrypted browser-first database for small, read-heavy web
applications. Object storage is the durable source of truth. The application
owns its authority, identity provider, keys, storage, retention, and backups.

## Start here

- [Should you use ThimbleDB for a vibe-coded app?](${site.url}/vibe-coded-apps/): Exact fit and rejection criteria for AI-assisted small apps.
- [Quickstart](${site.url}/docs/quickstart/): Install the package and configure Cloudflare, Node, and browser clients.
- [Starter examples](${site.url}/examples/): Local notes and Cloudflare authority examples.
- [Use cases](${site.url}/use-cases/): Complete workload-specific guides.
- [Database comparisons](${site.url}/compare/): Fair comparisons with D1, SQLite, Firestore, lowdb, and direct object storage.

## Architecture and security

- [Architecture](${site.url}/docs/architecture/): Browser cache, authority, object storage, and scopes.
- [Security](${site.url}/security/): Threat model, encryption, key handling, and browser boundaries.
- [Authentication](${site.url}/docs/authentication/): External OIDC identities and revocable sessions.
- [Object protocol](${site.url}/docs/protocol/): TDB1 envelopes, snapshots, tries, and conditional writes.
- [Deletion and retention](${site.url}/docs/deletion-retention/): Tombstones, restore windows, and physical collection.

## Evidence and limits

- [Tradeoffs](${site.url}/docs/tradeoffs/): Verified behaviour, unknowns, and poor-fit workloads.
- [R2 browser benchmarks](${site.url}/benchmarks/): Multi-region evidence and limitations.
- [Public package API](${site.url}/docs/public-api/): Stable package exports.
- [GitHub repository](${site.repository}): Source, tests, examples, fixtures, and raw evidence.
- [npm package](${site.npm}): Published package.

## Important limits

ThimbleDB does not provide SQL, joins, multi-record ACID transactions,
full-text search, vector search, analytical queries, real-time collaboration,
or offline write conflict resolution. It does not claim general performance
or cost superiority over another database.
`);
}

function text(body: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
