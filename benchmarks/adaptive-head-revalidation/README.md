# Adaptive HEAD revalidation experiment

This harness compares four browser HEAD freshness policies without changing
the Snapshot or Trie storage protocols:

1. current 1 second TTL, with 304 freshness measured from request start
2. fixed 1 second TTL measured from response completion
3. fixed 10 second TTL measured from response completion
4. adaptive 1-10 second TTL that doubles after each 304 and resets after a
   changed HEAD

Real Chromium instances run in disposable Azure Container Instances. Each
policy and layout uses an isolated R2 prefix and one deterministic document.

## Measured phases

- one cold point read
- 20 seconds of stable hot reads
- a remote mutation immediately after a successful HEAD revalidation
- time and stale reads until the first mutation becomes visible
- a second mutation immediately after the first is observed
- time and stale reads until the burst mutation becomes visible
- cached offline fallback

The controlled mutation phases separate stable request reduction from the
freshness delay it introduces.

## Build

```powershell
npm run benchmark:adaptive-revalidation:build
```

Generated browser assets, deployment configuration, tokens, and downloaded
regional results remain below the ignored
`.bench-data/adaptive-head-revalidation` directory.

## Evidence layout

```text
.bench-data/adaptive-head-revalidation/results/read-a/<region>.json
.bench-data/adaptive-head-revalidation/results/read-b/<region>.json
```

Aggregate with:

```powershell
npm run benchmark:adaptive-revalidation:aggregate
```

The default artifact is:

```text
evidence/adaptive-head-revalidation-regional-browser-2026-09-27.json
```

No production Worker, bucket, route, domain, package export, or storage
protocol is used or changed by this experiment.
