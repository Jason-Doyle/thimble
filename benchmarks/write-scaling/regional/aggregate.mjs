import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  WRITE_SCALING_INDEX_SETS,
  WRITE_SCALING_LAYOUTS,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_OUTPUT ??
    ".bench-data/write-scaling-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_EVIDENCE ??
    "evidence/write-scaling-regional-worker-2026-09-27.json",
);
const replicates = (
  process.env.THIMBLE_WRITE_SCALING_REPLICATES ??
    "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const runs = await loadRuns();
const cases = collectCases(runs);
const summaries = Object.fromEntries(
  Object.entries(cases).map(([name, samples]) => [
    name,
    summarise(samples),
  ]),
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
  layouts: manifest.matrix,
  methodology: {
    execution:
      "Disposable Azure Node 22 callers invoked the unchanged production Snapshot and Trie write paths against isolated R2 prefixes.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    iterationsPerCase: 4,
    matrix:
      "128, 5,000, and 25,000 documents with zero, one, and two covering secondary indexes.",
    primaryLatency:
      "clientElapsedMs measured around one complete document write",
    stageMetrics:
      "R2 get and put durations are grouped by HEAD, snapshot, Trie node, and index object. Worker elapsed time remains I/O-oriented.",
  },
  limitations: [
    "The benchmark updates one document per request and does not measure mutation batching.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Authentication and browser rendering were excluded.",
    "Cloudflare Worker timers do not measure CPU-only work normally.",
    "The benchmark compares ThimbleDB layouts and index counts, not another database.",
  ],
  totals: {
    operations: Object.values(cases).reduce(
      (total, samples) =>
        total + samples.length,
      0,
    ),
    runs: runs.length,
  },
  overall: {
    cases: summaries,
    comparisons: buildComparisons(summaries),
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
  overall: evidence.overall,
}, null, 2));

async function loadRuns() {
  const loaded = [];
  for (const replicate of replicates) {
    for (const region of BENCHMARK_REGIONS) {
      const file = path.join(
        root,
        "results",
        `write-${replicate}`,
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
    meanCasRetries: mean(
      successful.map(
        (sample) =>
          sample.diagnostics?.casRetries ??
            0,
      ),
    ),
    byKind: aggregateKinds(successful),
    failures: failureCounts(samples),
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
        meanWriteCount: mean(
          samples.map(
            (sample) =>
              sample.storage.byKind?.[kind]
                ?.writes.count ?? 0,
          ),
        ),
        meanWriteBytes: Math.round(
          mean(
            samples.map(
              (sample) =>
                sample.storage.byKind?.[kind]
                  ?.writes.bytes ?? 0,
            ),
          ),
        ),
        meanWriteDurationMs: mean(
          samples.map(
            (sample) =>
              sample.storage.byKind?.[kind]
                ?.writes.durationMs ?? 0,
          ),
        ),
      },
    ]),
  );
}

function buildComparisons(summary) {
  const result = {};
  for (const profile of Object.keys(
    BENCHMARK_PROFILES,
  )) {
    for (const layout of WRITE_SCALING_LAYOUTS) {
      const noIndexes =
        summary[
          `write-${profile}-none-${layout}`
        ];
      for (const indexSet of Object.keys(
        WRITE_SCALING_INDEX_SETS,
      )) {
        const value =
          summary[
            `write-${profile}-${indexSet}-${layout}`
          ];
        result[
          `${profile}-${indexSet}-${layout}-vs-no-index`
        ] = compare(value, noIndexes);
      }
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
    readBytesChangePercent: change(
      candidate.meanReadBytes,
      baseline.meanReadBytes,
    ),
    writeCountChangePercent: change(
      candidate.meanWrites,
      baseline.meanWrites,
    ),
    writeBytesChangePercent: change(
      candidate.meanWriteBytes,
      baseline.meanWriteBytes,
    ),
  };
}

function failureCounts(samples) {
  return Object.fromEntries(
    Object.entries(
      samples
        .filter(
          (sample) => sample.success === false,
        )
        .reduce((result, sample) => {
          const message =
            sample.error ?? "Unknown error";
          result[message] =
            (result[message] ?? 0) + 1;
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
    (((value - baseline) / baseline) * 100)
      .toFixed(2),
  );
}

function percent(value, total) {
  return total === 0
    ? 0
    : Number(
        ((value / total) * 100).toFixed(2),
      );
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

function unique(values) {
  return [...new Set(values)].sort();
}
