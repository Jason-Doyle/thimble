# Comparative application harness

This harness defines one deterministic notes workload for database adapters.
Its purpose is to keep application operations and result structure
reproducible across adapters.

Run the local smoke adapters:

```powershell
npm run benchmark:compare:local
```

The checked-in adapters are:

- ThimbleDB local immutable snapshot engine
- Node's built-in in-memory SQLite

These adapters exercise different architectures and exclude the browser,
network, identity, cloud storage, and provider billing paths. Their timings
are local smoke evidence, not a ThimbleDB versus SQLite product benchmark.

Cloudflare D1 and Firestore results require deployed adapters that use the
same application operations, region controls, dataset, warm-up policy, and
evidence format. Management APIs and emulators do not establish production
performance.

Every result is written to `benchmark-results` with an explicit environment
description and warning.
