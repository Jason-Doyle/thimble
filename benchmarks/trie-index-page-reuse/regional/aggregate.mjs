import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  INDEX_REUSE_INDEX_SETS,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_INDEX_REUSE_OUTPUT ??
    ".bench-data/trie-index-page-reuse-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_INDEX_REUSE_EVIDENCE ??
    "evidence/trie-index-page-reuse-regional-worker-2026-09-30.json",
);
const replicates = (
  process.env.THIMBLE_INDEX_REUSE_REPLICATES ??
    "a,b"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const manifest = JSON.parse(
  await readFile(
    path.join(root, "manifest.json"),
    "utf8",
  ),
);
const runs = await loadRuns();
const cases = collectCases(runs);
const summaries = Object.fromEntries(
  Object.entries(cases).map(([name, samples]) => [
    name,
    summarise(samples),
  ]),
);
const comparisons = buildComparisons(summaries);
const verification = runs.flatMap((run) =>
  run.result.verification.map((value) => ({
    replicate: run.replicate,
    region: run.region,
    ...value,
  })),
);

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit: manifest.sourceCommit,
  harnessCommits: unique(
    runs.map((run) => run.result.harnessCommit),
  ),
  target:
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionChanged: false,
  profiles: manifest.profiles,
  indexSets: manifest.indexSets,
  modes: manifest.modes,
  methodology: {
    execution:
      "Disposable Azure Node 22 callers compared the production index-page reuse path with a control wrapper that duplicates each index get.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    iterationsPerCase: 4,
    matrix:
      "128, 5,000, and 25,000 documents with one and two secondary indexes.",
    primaryLatency:
      "clientElapsedMs measured one complete Trie document update.",
    equivalence:
      "Post-run stored documents and active HEAD values were compared between control and candidate prefixes.",
  },
  acceptance: {
    allWritesSucceeded:
      Object.values(summaries).every(
        (summary) => summary.failed === 0,
      ),
    protocolEquivalent:
      verification.every(
        (value) => value.equivalent,
      ),
    exactReadReduction:
      ["small", "medium", "large"].every(
        (profile) =>
          comparisons[`${profile}-one`]
            .candidateReads === 5 &&
          comparisons[`${profile}-two`]
            .candidateReads === 6,
      ),
    mediumAndLargeP50AtLeast10Percent:
      ["medium", "large"].every((profile) =>
        Object.keys(INDEX_REUSE_INDEX_SETS).every(
          (indexSet) =>
            comparisons[
              `${profile}-${indexSet}`
            ].p50ChangePercent <= -10,
        ),
      ),
    p95DoesNotRegressMoreThan10Percent:
      Object.values(comparisons).every(
        (comparison) =>
          comparison.p95ChangePercent <= 10,
      ),
  },
  limitations: [
    "The control reproduces the old operation count by duplicating each immutable index get around the candidate engine.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Authentication and browser rendering were excluded.",
    "Cloudflare Worker timers do not measure CPU-only work normally.",
  ],
  totals: {
    operations: Object.values(cases).reduce(
      (total, samples) =>
        total + samples.length,
      0,
    ),
    runs: runs.length,
    verificationCases: verification.length,
  },
  overall: {
    cases: summaries,
    comparisons,
  },
  regions: Object.fromEntries(
    BENCHMARK_REGIONS.map((region) => {
      const regional = collectCases(
        runs.filter(
          (run) => run.region === region,
        ),
      );
      const regionalSummary =
        Object.fromEntries(
          Object.entries(regional).map(
            ([name, samples]) => [
              name,
              summarise(samples),
            ],
          ),
        );
      return [
        region,
        {
          cases: regionalSummary,
          comparisons:
            buildComparisons(regionalSummary),
        },
      ];
    }),
  ),
  verification,
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
  acceptance: evidence.acceptance,
  comparisons: evidence.overall.comparisons,
}, null, 2));

async function loadRuns() {
  const loaded = [];
  for (const replicate of replicates) {
    for (const region of BENCHMARK_REGIONS) {
      const file = path.join(
        root,
        "results",
        `index-reuse-${replicate}`,
        `${region}.json`,
      );
      loaded.push({
        replicate,
        region,
        result: JSON.parse(
          await readFile(file, "utf8"),
        ),
      });
    }
  }
  return loaded;
}

function collectCases(selected) {
  const result = {};
  for (const run of selected) {
    for (const [name, samples] of Object.entries(
      run.result.samples,
    )) {
      result[name] ??= [];
      result[name].push(...samples);
    }
  }
  return result;
}

function summarise(samples) {
  const successful = samples.filter(
    (sample) => sample.success !== false,
  );
  const elapsed = sorted(
    successful.map(
      (sample) => sample.clientElapsedMs,
    ),
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
    workerMeanMs: mean(
      successful.map(
        (sample) =>
          sample.workerIoTimerMs ?? 0,
      ),
    ),
    meanReads: mean(
      successful.map(
        (sample) =>
          sample.storage.reads.count,
      ),
    ),
    meanReadBytes: Math.round(
      mean(
        successful.map(
          (sample) =>
            sample.storage.reads.bytes,
        ),
      ),
    ),
    meanReadDurationMs: mean(
      successful.map(
        (sample) =>
          sample.storage.reads.durationMs,
      ),
    ),
    meanWrites: mean(
      successful.map(
        (sample) =>
          sample.storage.writes.count,
      ),
    ),
    meanWriteBytes: Math.round(
      mean(
        successful.map(
          (sample) =>
            sample.storage.writes.bytes,
        ),
      ),
    ),
    meanWriteDurationMs: mean(
      successful.map(
        (sample) =>
          sample.storage.writes.durationMs,
      ),
    ),
    byKind: aggregateKinds(successful),
    failures: failureCounts(samples),
  };
}

function buildComparisons(summary) {
  const result = {};
  for (const profile of Object.keys(
    BENCHMARK_PROFILES,
  )) {
    for (const indexSet of Object.keys(
      INDEX_REUSE_INDEX_SETS,
    )) {
      const candidate =
        summary[
          `write-${profile}-${indexSet}-reuse`
        ];
      const baseline =
        summary[
          `write-${profile}-${indexSet}-duplicate`
        ];
      result[`${profile}-${indexSet}`] = {
        ...compare(candidate, baseline),
        baselineReads: baseline.meanReads,
        candidateReads: candidate.meanReads,
      };
    }
  }
  return result;
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
    readCountChangePercent: change(
      candidate.meanReads,
      baseline.meanReads,
    ),
    readByteChangePercent: change(
      candidate.meanReadBytes,
      baseline.meanReadBytes,
    ),
  };
}

function aggregateKinds(samples) {
  const kinds = new Set(
    samples.flatMap((sample) =>
      Object.keys(
        sample.storage.byKind ?? {},
      ),
    ),
  );
  return Object.fromEntries(
    [...kinds].sort().map((kind) => [
      kind,
      {
        meanReadCount: mean(
          samples.map(
            (sample) =>
              sample.storage.byKind?.[kind]
                ?.reads.count ?? 0,
          ),
        ),
        meanReadBytes: Math.round(
          mean(
            samples.map(
              (sample) =>
                sample.storage.byKind?.[kind]
                  ?.reads.bytes ?? 0,
            ),
          ),
        ),
        meanReadDurationMs: mean(
          samples.map(
            (sample) =>
              sample.storage.byKind?.[kind]
                ?.reads.durationMs ?? 0,
          ),
        ),
      },
    ]),
  );
}

function failureCounts(samples) {
  const counts = {};
  for (const sample of samples) {
    if (sample.success !== false) {
      continue;
    }
    const key =
      sample.error ??
      `HTTP ${sample.status ?? 0}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sorted(values) {
  return [...values].sort(
    (left, right) => left - right,
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
  return Number(
    (
      values.reduce(
        (total, value) => total + value,
        0,
      ) / values.length
    ).toFixed(3),
  );
}

function percent(value, total) {
  return total === 0
    ? 0
    : Number(
        ((value / total) * 100).toFixed(2),
      );
}

function change(candidate, baseline) {
  if (baseline === 0) {
    return candidate === 0 ? 0 : null;
  }
  return Number(
    (
      ((candidate - baseline) / baseline) *
      100
    ).toFixed(2),
  );
}

function unique(values) {
  return [...new Set(values)].sort();
}
