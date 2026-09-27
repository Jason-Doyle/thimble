import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
} from "../current-regional/scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_EDGE_CACHE_REGIONAL_OUTPUT ??
    ".bench-data/immutable-edge-cache",
);
const outputPath = path.resolve(
  process.env.THIMBLE_EDGE_CACHE_REGIONAL_EVIDENCE ??
    "evidence/immutable-edge-cache-regional-worker-2026-09-27.json",
);
const replicates = (
  process.env.THIMBLE_EDGE_CACHE_REPLICATES ?? "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const runs = await loadRuns();
const sourceCommits = unique(
  runs.map((run) => run.result.sourceCommit),
);
const harnessCommits = unique(
  runs.map((run) => run.result.harnessCommit),
);

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit:
    sourceCommits.length === 1
      ? sourceCommits[0]
      : sourceCommits,
  harnessCommits,
  target:
    "temporary workers.dev Worker, Cloudflare Cache API, and temporary Cloudflare R2 bucket",
  productionChanged: false,
  profiles: Object.fromEntries(
    Object.entries(manifest.profiles).map(
      ([name, profile]) => [
        name,
        {
          documents: profile.documents,
          decodedSnapshotBytes:
            profile.decodedSnapshotBytes,
          layouts: profile.layouts,
          expected: profile.expected,
        },
      ],
    ),
  ),
  methodology: {
    execution:
      "Disposable Azure Node 22 clients ran the current browser read planner over HTTPS. The baseline and candidate used the same authorization gate and encrypted R2 objects.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    iterations:
      runs[0]?.result.iterations ?? null,
    baseline:
      "Authorized object and bundle requests read every required object from R2.",
    candidate:
      "Authorization completed before a colo-local Cloudflare Cache API lookup. Mutable collection HEAD objects always bypassed cache. Only encrypted content-addressed snapshot, trie-node, and secondary-index objects were cached.",
    coldCandidate:
      "A unique cache namespace forced an immutable-object miss for each measured operation.",
    warmCandidate:
      "Each operation used a fresh browser client after its required immutable objects were confirmed present in the serving Cloudflare colo cache.",
    primaryLatency:
      "clientElapsedMs measured around the complete regional operation",
  },
  security: summariseSecurity(runs),
  limitations: [
    "Cloudflare Cache API entries are data-centre local and are not tiered or globally replicated by this experiment.",
    "The benchmark token models an authorization gate but does not include OIDC login, session lookup, or grant lookup latency.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "Node 22 executed the browser client code, so IndexedDB, browser scheduling, and rendering were not measured.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Prewarming is an explicit best case and does not establish a production cache-hit ratio.",
    "Forced misses use isolated cache namespaces and therefore do not model cache eviction under production traffic.",
    "The benchmark compares ThimbleDB read paths, not another database.",
  ],
  totals: {
    operations: countOperations(runs),
    runs: runs.length,
  },
  overall: aggregateRuns(runs),
  regions: Object.fromEntries(
    BENCHMARK_REGIONS.map((region) => [
      region,
      aggregateRuns(
        runs.filter((run) => run.region === region),
      ),
    ]),
  ),
  runs,
};

await mkdir(path.dirname(outputPath), {
  recursive: true,
});
await writeFile(
  outputPath,
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify({
  outputPath,
  totals: evidence.totals,
  security: evidence.security,
  overall: evidence.overall,
}, null, 2));

async function loadRuns() {
  const loaded = [];
  for (const replicate of replicates) {
    for (const region of BENCHMARK_REGIONS) {
      const file = path.join(
        root,
        "results",
        `read-${replicate}`,
        `${region}.json`,
      );
      loaded.push({
        replicate,
        region,
        result: JSON.parse(await readFile(file, "utf8")),
      });
    }
  }
  return loaded;
}

function aggregateRuns(selectedRuns) {
  const profiles = {};
  for (const profile of Object.keys(BENCHMARK_PROFILES)) {
    const groups = {};
    for (const group of ["point", "queries", "scans"]) {
      const cases = collectCases(
        selectedRuns,
        profile,
        group,
      );
      groups[group] = Object.fromEntries(
        Object.entries(cases).map(
          ([name, samples]) => [
            name,
            summarise(samples),
          ],
        ),
      );
    }
    profiles[profile] = {
      ...groups,
      comparisons: comparisons(groups),
    };
  }
  return { profiles };
}

function collectCases(
  selectedRuns,
  profile,
  group,
) {
  const cases = {};
  for (const run of selectedRuns) {
    const values =
      run.result.profiles[profile][group];
    for (const [name, samples] of Object.entries(values)) {
      cases[name] ??= [];
      cases[name].push(...samples);
    }
  }
  return cases;
}

function comparisons(groups) {
  const values = {};
  for (const operation of [
    "point",
    "bundle",
    "covered-equality",
    "uncovered-equality",
    "covered-range",
    "scan",
  ]) {
    const group =
      operation === "point" || operation === "bundle"
        ? groups.point
        : operation === "scan"
          ? groups.scans
          : groups.queries;
    for (const layout of ["snapshot", "trie"]) {
      const baseline =
        group[`${operation}-baseline-${layout}`];
      const warm =
        group[`${operation}-edge-warm-${layout}`];
      const cold =
        group[`${operation}-edge-cold-${layout}`];
      values[`${operation}-${layout}`] = {
        edgeWarmVsBaseline: compare(warm, baseline),
        edgeColdVsBaseline: compare(cold, baseline),
      };
    }
  }
  return values;
}

function summarise(samples) {
  const successful = samples.filter(
    (sample) => sample.success !== false,
  );
  const elapsed = sorted(
    successful.map((sample) => sample.clientElapsedMs),
  );
  return {
    operations: samples.length,
    successful: successful.length,
    failed: samples.length - successful.length,
    successRatePercent: percent(
      successful.length,
      samples.length,
    ),
    clientP50Ms: percentile(elapsed, 0.5),
    clientP95Ms: percentile(elapsed, 0.95),
    clientMeanMs: mean(elapsed),
    meanNetworkReads: mean(
      successful.map((sample) => sample.networkReads),
    ),
    meanNetworkBytes: Math.round(
      mean(successful.map((sample) => sample.networkBytes)),
    ),
    meanStorageReads: mean(
      successful.map((sample) => sample.storageReads),
    ),
    meanStorageBytes: Math.round(
      mean(successful.map((sample) => sample.storageBytes)),
    ),
    meanEdgeCacheHits: mean(
      successful.map((sample) => sample.edgeCacheHits),
    ),
    meanEdgeCacheHitBytes: Math.round(
      mean(
        successful.map(
          (sample) => sample.edgeCacheHitBytes,
        ),
      ),
    ),
    meanEdgeCacheMisses: mean(
      successful.map((sample) => sample.edgeCacheMisses),
    ),
    meanEdgeCacheBypasses: mean(
      successful.map(
        (sample) => sample.edgeCacheBypasses,
      ),
    ),
    meanDocuments: mean(
      successful.map((sample) => sample.documents),
    ),
    meanScannedDocuments: mean(
      successful.map(
        (sample) => sample.scannedDocuments,
      ),
    ),
    failures: failureCounts(samples),
  };
}

function compare(candidate, baseline) {
  return {
    p50ChangePercent: change(
      candidate.clientP50Ms,
      baseline.clientP50Ms,
    ),
    p95ChangePercent: change(
      candidate.clientP95Ms,
      baseline.clientP95Ms,
    ),
    networkReadChangePercent: change(
      candidate.meanNetworkReads,
      baseline.meanNetworkReads,
    ),
    networkByteChangePercent: change(
      candidate.meanNetworkBytes,
      baseline.meanNetworkBytes,
    ),
    storageReadChangePercent: change(
      candidate.meanStorageReads,
      baseline.meanStorageReads,
    ),
    storageByteChangePercent: change(
      candidate.meanStorageBytes,
      baseline.meanStorageBytes,
    ),
    successRatePointChange:
      candidate.successRatePercent -
      baseline.successRatePercent,
  };
}

function summariseSecurity(selectedRuns) {
  const samples = selectedRuns.map(
    (run) => run.result.security,
  );
  return {
    runs: samples.length,
    configWithoutTokenStatuses: counts(
      samples.map((sample) => sample.configWithoutToken),
    ),
    objectWithoutTokenStatuses: counts(
      samples.map((sample) => sample.objectWithoutToken),
    ),
    cachedObjectWithoutTokenStatuses: counts(
      samples.map(
        (sample) => sample.cachedObjectWithoutToken,
      ),
    ),
    passed: samples.every(
      (sample) =>
        sample.configWithoutToken === 403 &&
        sample.objectWithoutToken === 403 &&
        sample.cachedObjectWithoutToken === 403,
    ),
  };
}

function countOperations(selectedRuns) {
  let total = 0;
  for (const run of selectedRuns) {
    for (const profile of Object.values(
      run.result.profiles,
    )) {
      for (const group of [
        profile.point,
        profile.queries,
        profile.scans,
      ]) {
        for (const samples of Object.values(group)) {
          total += samples.length;
        }
      }
    }
  }
  return total;
}

function failureCounts(samples) {
  return Object.fromEntries(
    Object.entries(
      samples
        .filter((sample) => sample.success === false)
        .reduce((result, sample) => {
          const message = sample.error ?? "Unknown error";
          result[message] = (result[message] ?? 0) + 1;
          return result;
        }, {}),
    ).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function counts(values) {
  return Object.fromEntries(
    Object.entries(
      values.reduce((result, value) => {
        const key = String(value);
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {}),
    ).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function change(value, baseline) {
  if (
    value === undefined ||
    baseline === undefined ||
    baseline === 0
  ) {
    return null;
  }
  return Number(
    (((value - baseline) / baseline) * 100).toFixed(2),
  );
}

function percent(value, total) {
  return total === 0
    ? 0
    : Number(((value / total) * 100).toFixed(2));
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

function percentile(values, quantile) {
  if (values.length === 0) {
    return 0;
  }
  return values[
    Math.min(
      values.length - 1,
      Math.ceil(values.length * quantile) - 1,
    )
  ];
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return Number(
    (
      values.reduce((total, value) => total + value, 0) /
      values.length
    ).toFixed(3),
  );
}

function unique(values) {
  return [...new Set(values)].sort();
}
