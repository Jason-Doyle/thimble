# Comparative application harness

This harness defines one deterministic notes workload for database adapters.
It exists to make future comparisons reproducible. It does not currently
support a production performance claim.

Run the local smoke adapters:

```powershell
npm run benchmark:compare:local
```

The checked-in adapters are:

- ThimbleDB local immutable snapshot engine
- Node's built-in in-memory SQLite

These adapters exercise different architectures and exclude the browser,
network, identity, cloud storage, and provider billing paths. Their timings
must not be presented as a ThimbleDB versus SQLite product benchmark.

Cloudflare D1 and Firestore results require deployed adapters that use the
same application operations, region controls, dataset, warm-up policy, and
evidence format. Do not substitute management APIs or emulators and describe
the result as production evidence.

Every result is written to `benchmark-results` with an explicit environment
description and warning.
