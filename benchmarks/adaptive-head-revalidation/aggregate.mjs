import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_LAYOUTS,
  BENCHMARK_POLICIES,
  BENCHMARK_REGIONS,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_ADAPTIVE_REVALIDATION_OUTPUT ??
    ".bench-data/adaptive-head-revalidation",
);
const outputPath = path.resolve(
  process.env.THIMBLE_ADAPTIVE_REVALIDATION_EVIDENCE ??
    "evidence/adaptive-head-revalidation-regional-browser-2026-09-27.json",
);
const replicates = (
  process.env.THIMBLE_ADAPTIVE_REVALIDATION_REPLICATES ??
    "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
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
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionChanged: false,
  methodology: {
    execution:
      "Disposable Azure Playwright containers ran real headless Chromium against the temporary Worker. Each policy and layout used an isolated R2 prefix.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    policies: {
      "current-1s":
        "Current main behaviour: fixed 1 second TTL and 304 freshness timestamped at request start.",
      "completion-1s":
        "Fixed 1 second TTL with freshness timestamped when revalidation completes.",
      "fixed-10s":
        "Fixed 10 second TTL timestamped when revalidation completes.",
      "adaptive-1-to-10s":
        "Starts at 1 second, doubles after each 304 to 10 seconds, and resets to 1 second after a changed HEAD or read bundle.",
    },
    phases: [
      "cold point read",
      "20 seconds of stable hot reads",
      "wait for a successful policy boundary revalidation",
      "remote mutation and polling until version 1 is visible",
      "immediate second mutation and polling until version 2 is visible",
      "offline cached read",
    ],
    primaryLatency:
      "Chromium performance.now() around each complete ThimbleClient point read",
    freshness:
      "Detection delay begins after the protected mutation endpoint has completed its R2 write and HEAD publication.",
  },
  security: summariseSecurity(runs),
  limitations: [
    "The workload contains one document and isolates HEAD freshness rather than collection scale.",
    "The mutation test deliberately measures near-worst-case delay by mutating immediately after a successful HEAD revalidation.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "The benchmark token models route authorization but omits OIDC login and session-store latency.",
    "The adaptive state is in memory and conservatively resets after a page reload.",
    "No focus, visibility, push notification, or server-sent invalidation signal was tested.",
    "The benchmark compares ThimbleDB freshness policies, not another database.",
  ],
  totals: {
    runs: runs.length,
    scenarios: runs.reduce(
      (total, run) =>
        total + run.result.scenarios.length,
      0,
    ),
    measuredReads: countReads(runs),
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
  const cases = {};
  for (const policy of BENCHMARK_POLICIES) {
    for (const layout of BENCHMARK_LAYOUTS) {
      const name = `${policy}-${layout}`;
      const scenarios = selectedRuns.flatMap((run) =>
        run.result.scenarios.filter(
          (scenario) =>
            scenario.policy === policy &&
            scenario.layout === layout,
        ),
      );
      cases[name] = summariseScenarios(scenarios);
    }
  }
  return {
    cases,
    comparisons: Object.fromEntries(
      BENCHMARK_LAYOUTS.flatMap((layout) => {
        const baseline = cases[`current-1s-${layout}`];
        return BENCHMARK_POLICIES
          .filter((policy) => policy !== "current-1s")
          .map((policy) => [
            `${policy}-${layout}`,
            compare(
              cases[`${policy}-${layout}`],
              baseline,
            ),
          ]);
      }),
    ),
  };
}

function summariseScenarios(scenarios) {
  const stableSamples = scenarios.flatMap(
    (scenario) => scenario.stable.samples,
  );
  const boundarySamples = scenarios.flatMap(
    (scenario) => scenario.boundary.samples,
  );
  const firstSamples = scenarios.flatMap(
    (scenario) => scenario.firstMutation.samples,
  );
  const secondSamples = scenarios.flatMap(
    (scenario) => scenario.secondMutation.samples,
  );
  const stableElapsed = scenarios.reduce(
    (total, scenario) =>
      total + scenario.stable.elapsedMs,
    0,
  );
  const stableRemoteReads = scenarios.reduce(
    (total, scenario) =>
      total + scenario.stable.metrics.remoteReads,
    0,
  );
  const stableNotModified = scenarios.reduce(
    (total, scenario) =>
      total + scenario.stable.metrics.notModified,
    0,
  );
  return {
    scenarios: scenarios.length,
    cold: summariseValues(
      scenarios.map((scenario) => scenario.cold.elapsedMs),
    ),
    stable: {
      ...summariseValues(
        stableSamples.map((sample) => sample.elapsedMs),
      ),
      operations: stableSamples.length,
      elapsedMs: round(stableElapsed),
      operationsPerSecond:
        stableElapsed === 0
          ? 0
          : round(
              (stableSamples.length * 1_000) /
                stableElapsed,
            ),
      remoteReads: stableRemoteReads,
      remoteReadsPerMinute:
        stableElapsed === 0
          ? 0
          : round(
              (stableRemoteReads * 60_000) /
                stableElapsed,
            ),
      notModified: stableNotModified,
      notModifiedPerMinute:
        stableElapsed === 0
          ? 0
          : round(
              (stableNotModified * 60_000) /
                stableElapsed,
            ),
    },
    boundary: {
      elapsed: summariseValues(
        scenarios.map(
          (scenario) => scenario.boundary.elapsedMs,
        ),
      ),
      readLatency: summariseValues(
        boundarySamples.map(
          (sample) => sample.elapsedMs,
        ),
      ),
      operations: boundarySamples.length,
    },
    firstMutation: summariseMutation(
      scenarios.map(
        (scenario) => scenario.firstMutation,
      ),
      firstSamples,
    ),
    secondMutation: summariseMutation(
      scenarios.map(
        (scenario) => scenario.secondMutation,
      ),
      secondSamples,
    ),
    offline: {
      successful: scenarios.filter(
        (scenario) =>
          scenario.offline.version === 2 &&
          scenario.offline.offlineFallbacks === 1,
      ).length,
      total: scenarios.length,
    },
  };
}

function summariseMutation(mutations, samples) {
  return {
    detectionDelay: summariseValues(
      mutations.map(
        (mutation) => mutation.detectionDelayMs,
      ),
    ),
    staleReads: summariseValues(
      mutations.map(
        (mutation) => mutation.staleReads,
      ),
    ),
    probeLatency: summariseValues(
      samples.map((sample) => sample.elapsedMs),
    ),
    operations: samples.length,
    remoteReads: mutations.reduce(
      (total, mutation) =>
        total + mutation.metrics.remoteReads,
      0,
    ),
  };
}

function compare(candidate, baseline) {
  return {
    stableP50ChangePercent: change(
      candidate.stable.p50,
      baseline.stable.p50,
    ),
    stableP95ChangePercent: change(
      candidate.stable.p95,
      baseline.stable.p95,
    ),
    stableRemoteReadRateChangePercent: change(
      candidate.stable.remoteReadsPerMinute,
      baseline.stable.remoteReadsPerMinute,
    ),
    stableThroughputChangePercent: change(
      candidate.stable.operationsPerSecond,
      baseline.stable.operationsPerSecond,
    ),
    firstDetectionP50ChangePercent: change(
      candidate.firstMutation.detectionDelay.p50,
      baseline.firstMutation.detectionDelay.p50,
    ),
    firstDetectionP95ChangePercent: change(
      candidate.firstMutation.detectionDelay.p95,
      baseline.firstMutation.detectionDelay.p95,
    ),
    secondDetectionP50ChangePercent: change(
      candidate.secondMutation.detectionDelay.p50,
      baseline.secondMutation.detectionDelay.p50,
    ),
    secondDetectionP95ChangePercent: change(
      candidate.secondMutation.detectionDelay.p95,
      baseline.secondMutation.detectionDelay.p95,
    ),
  };
}

function summariseValues(values) {
  const sorted = [...values].sort(
    (left, right) => left - right,
  );
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    mean: mean(sorted),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function summariseSecurity(selectedRuns) {
  const values = selectedRuns.map(
    (run) => run.result.security,
  );
  return {
    runs: values.length,
    configWithoutTokenStatuses: counts(
      values.map(
        (value) => value.configWithoutToken,
      ),
    ),
    prepareWithoutTokenStatuses: counts(
      values.map(
        (value) => value.prepareWithoutToken,
      ),
    ),
    passed: values.every(
      (value) =>
        value.configWithoutToken === 403 &&
        value.prepareWithoutToken === 403,
    ),
  };
}

function countReads(selectedRuns) {
  return selectedRuns.reduce(
    (runTotal, run) =>
      runTotal +
      run.result.scenarios.reduce(
        (scenarioTotal, scenario) =>
          scenarioTotal +
          1 +
          scenario.stable.operations +
          scenario.boundary.operations +
          scenario.firstMutation.operations +
          scenario.secondMutation.operations +
          1,
        0,
      ),
    0,
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
  if (baseline === 0) {
    return null;
  }
  return Number(
    (((value - baseline) / baseline) * 100).toFixed(2),
  );
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
  return round(
    values.reduce((total, value) => total + value, 0) /
      values.length,
  );
}

function round(value) {
  return Number(value.toFixed(3));
}

function unique(values) {
  return [...new Set(values)].sort();
}
