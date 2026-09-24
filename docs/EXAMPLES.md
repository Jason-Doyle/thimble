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
