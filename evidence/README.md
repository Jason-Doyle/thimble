# Raw evidence

This directory contains selected benchmark artifacts that support documented
claims.

`azure-standard-small.json` is the unmodified result produced by:

```powershell
npm run benchmark -- --provider azure --profile small
```

The artifact contains operation counts, bytes, latency percentiles, conflicts,
cache metrics, object counts, and stored bytes. It contains no credentials.

Machine, network path, Azure region, and time of day affect the result. Treat
it as one reproducible observation, not a universal performance claim.
