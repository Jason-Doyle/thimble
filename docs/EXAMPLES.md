# Starter examples

The repository includes small examples that use only public package exports.
They are intended for evaluation and scaffolding, not as hidden production
frameworks.

## Local notes

Path: `examples/local-notes`

The local notes example uses:

- `ImmutableSnapshotEngine`
- `LocalObjectStore`
- document writes, reads, and scans
- Node's built-in test runner

Run it:

```powershell
cd examples\local-notes
npm install
npm run demo
npm test
```

Use this example to understand the engine and storage contract without
configuring an identity provider or cloud resources.

The example is not a complete authenticated web deployment.

## Generated local web application

Create a complete browser and Node authority example:

```powershell
npx thimbledb@latest create my-notes-app
cd my-notes-app
npm run dev
```

The scaffold includes:

- loopback-only development identity
- ready browser client factory
- encrypted local user scope
- typed notes collection
- title and modification-time indexes
- explicit covering fields for the indexed title result
- bounded point-read bundles on cold cache misses
- indexed lookup and ordering
- deletion and restore
- Vite development server
- same-origin packaged Studio at `http://127.0.0.1:5173/studio/`

Standalone templates:

- [Node starter](https://github.com/Jason-Doyle/thimbledb-node-starter)
  provides the same local-first authenticated flow in a repository that can be
  generated from GitHub.
- [Cloudflare starter](https://github.com/Jason-Doyle/thimbledb-cloudflare-starter)
  provides a Worker, static Vite application, external OIDC session exchange,
  private R2 bindings, typed notes, and declared indexes.

## Cloudflare notes authority

Path: `examples/cloudflare-notes`

The Cloudflare starter uses the stable authority export:

```ts
export { default } from "thimbledb/authority/cloudflare";
```

Validate the Worker bundle:

```powershell
cd examples\cloudflare-notes
npm install
npm run check
```

The checked-in Wrangler example keeps R2 bindings, domains, and identity
values commented out. Copy it before configuring real resources.

Continue with:

- [Quickstart](QUICKSTART.md)
- [Cloudflare deployment](DEPLOYMENT-CLOUDFLARE.md)
- [Authentication](AUTHENTICATION.md)
- [Security](SECURITY.md)

## Using an AI coding tool

Give the tool the exact example path and require it to preserve the documented
security boundaries:

```text
Start from the checked-in ThimbleDB example at [example path].

Use only documented public exports. Keep storage credentials, OIDC tokens,
master keys, and scope keys out of browser persistence. Do not add local
password authentication. Run the example tests and the repository validation
commands after making changes.
```

See [Implementation prompts](IMPLEMENTATION-PROMPTS.md) for complete prompts.
