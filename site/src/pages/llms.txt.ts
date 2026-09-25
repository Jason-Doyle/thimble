import { site } from "../data/site";

export const prerender = true;

export function GET() {
  return text(`# ThimbleDB

> ${site.description}

ThimbleDB is an encrypted browser-first database for small, read-heavy web
applications. Object storage is the durable source of truth. The application
owns its authority, identity provider, keys, storage, retention, and backups.

## Preferred starting path

\`npx thimbledb@latest create my-app\` generates a local Node authority and
Vite application. After a session exists, use \`createThimbleClient()\`, typed
collections, and declared secondary indexes. Queries remain bounded to one
scope and one collection.

## Start here

- [Should you use ThimbleDB for a vibe-coded app?](${site.url}/vibe-coded-apps/): Exact fit and rejection criteria for AI-assisted small apps.
- [Quickstart](${site.url}/docs/quickstart/): Install the package and configure Cloudflare, Node, and browser clients.
- [Local development](${site.url}/docs/development/): Scaffold a complete local app with the safe development identity.
- [Configuration reference](${site.url}/docs/configuration/): Authority options, environment variables, defaults, provider settings, and template coverage.
- [ThimbleDB Studio](${site.url}/docs/studio/): Package-owned management UI for explicit scopes, bounded queries, index health, exports, and guarded operations.
- [Starter examples](${site.url}/examples/): Local notes and Cloudflare authority examples.
- [Node starter repository](https://github.com/Jason-Doyle/thimbledb-node-starter): Local-first authenticated notes application.
- [Cloudflare starter repository](https://github.com/Jason-Doyle/thimbledb-cloudflare-starter): Worker, private R2, external OIDC, and typed notes.
- [Use cases](${site.url}/use-cases/): Complete workload-specific guides.
- [Database comparisons](${site.url}/compare/): Fair comparisons with D1, SQLite, Firestore, lowdb, and direct object storage.

## Architecture and security

- [Architecture](${site.url}/docs/architecture/): Browser cache, authority, object storage, and scopes.
- [Authority deployment modes](${site.url}/docs/authority-deployment/): Embedded and separate authority services, decision criteria, and same-origin requirements.
- [Security](${site.url}/security/): Threat model, encryption, key handling, and browser boundaries.
- [Authentication](${site.url}/docs/authentication/): External OIDC identities and revocable sessions.
- [Machine and service access](${site.url}/docs/service-access/): Entra roles, service principals, live viewers, and why there is no global admin key.
- [Object protocol](${site.url}/docs/protocol/): TDB1 envelopes, snapshots, tries, and conditional writes.
- [Queries and indexes](${site.url}/docs/queries-indexes/): Typed predicates, developer-declared secondary indexes, and explicit covering projections.
- [Deletion and retention](${site.url}/docs/deletion-retention/): Tombstones, restore windows, and physical collection.
- [Logical migration](${site.url}/docs/migration/): Portable archives and database adapters.

## Evidence and limits

- [Tradeoffs](${site.url}/docs/tradeoffs/): Verified behaviour, unknowns, and poor-fit workloads.
- [R2 browser benchmarks](${site.url}/benchmarks/): Multi-region evidence and limitations.
- [Public package API](${site.url}/docs/public-api/): Stable package exports.
- [Website privacy](${site.url}/docs/website-privacy/): Static-site data handling and Cloudflare Web Analytics disclosure.
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
