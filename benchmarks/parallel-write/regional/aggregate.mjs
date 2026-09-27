import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_REGIONS,
  PARALLEL_WRITE_LAYOUTS,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_PARALLEL_WRITE_REGIONAL_OUTPUT ??
    ".bench-data/parallel-write-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_PARALLEL_WRITE_EVIDENCE ??
    "evidence/parallel-write-regional-worker-2026-09-27.json",
);
const replicates = (
  process.env.THIMBLE_PARALLEL_WRITE_REPLICATES ??
    "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const runs = await loadRuns();
const cases = collectWriteCases(runs);
const writeSummary = Object.fromEntries(
  Object.entries(cases).map(([name, samples]) => [
    name,
    summariseWrites(samples),
  ]),
);
const readSummary = aggregateReads(runs);

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit: manifest.sourceCommit,
  harnessCommits: unique(
    runs.map((run) => run.result.harnessCommit),
  ),
  target:
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionChanged: false,
  documents: manifest.documents,
  indexes: manifest.indexes,
  layouts: manifest.layouts,
  methodology: {
    execution:
      "Disposable Azure Node 22 callers invoked current sequential and bounded-parallel authority writes. Every region and variant used an isolated prefix; replicates used recreated empty buckets.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    iterationsPerCase: 6,
    baseline:
      "Current sequential immutable object preparation and publication.",
    candidate:
      "Identical objects and HEAD protocol with validated index pages prepared first, then Snapshot/index or Trie/index immutable uploads overlapped at a maximum concurrency of three. HEAD remained the final awaited CAS publication.",
    primaryLatency:
      "clientElapsedMs measured around the complete regional write",
    stageTimers:
      "Engine performance timers are retained for diagnosis. Cloudflare Worker timers are I/O-oriented and do not measure CPU-only work normally.",
    browserAssist:
      "Stages are classified after measurement. No client-generated database objects were trusted by the authority.",
  },
  limitations: [
    "Regional evidence covers the current large 25,000-document, two-index workload; the local artifact covers 128, 5,000, and 25,000 documents with zero, one, and two indexes.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Authentication and application rendering were excluded.",
    "No simultaneous shared-generation contention was measured in this experiment.",
    "The benchmark compares ThimbleDB write scheduling, not another database.",
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
    writes: {
      cases: writeSummary,
      comparisons: Object.fromEntries(
        PARALLEL_WRITE_LAYOUTS.map((layout) => [
          layout,
          compare(
            writeSummary[`write-parallel-${layout}`],
            writeSummary[`write-sequential-${layout}`],
          ),
        ]),
      ),
    },
    reads: readSummary,
  },
  regions: Object.fromEntries(
    BENCHMARK_REGIONS.map((region) => [
      region,
      aggregateRegion(
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

function aggregateRegion(selected) {
  const regionalCases = collectWriteCases(selected);
  const summary = Object.fromEntries(
    Object.entries(regionalCases).map(
      ([name, samples]) => [
        name,
        summariseWrites(samples),
      ],
    ),
  );
  return {
    writes: {
      cases: summary,
      comparisons: Object.fromEntries(
        PARALLEL_WRITE_LAYOUTS.map((layout) => [
          layout,
          compare(
            summary[`write-parallel-${layout}`],
            summary[`write-sequential-${layout}`],
          ),
        ]),
      ),
    },
    reads: aggregateReads(selected),
  };
}

function collectWriteCases(selected) {
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

function summariseWrites(samples) {
  const successful = samples.filter(
    (sample) => sample.success !== false,
  );
  const elapsed = sorted(
    successful.map(
      (sample) => sample.clientElapsedMs,
    ),
  );
  const storage = successful.map(
    (sample) => sample.storage ?? {},
  );
  const diagnostics = successful.map(
    (sample) => sample.diagnostics ?? {},
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
    meanReads: mean(
      storage.map((value) => value.reads ?? 0),
    ),
    meanReadBytes: Math.round(
      mean(
        storage.map(
          (value) => value.readBytes ?? 0,
        ),
      ),
    ),
    meanWrites: mean(
      storage.map((value) => value.writes ?? 0),
    ),
    meanWriteBytes: Math.round(
      mean(
        storage.map(
          (value) => value.writtenBytes ?? 0,
        ),
      ),
    ),
    maximumConcurrentReads: Math.max(
      ...storage.map(
        (value) =>
          value.maximumConcurrentReads ?? 0,
      ),
    ),
    maximumConcurrentWrites: Math.max(
      ...storage.map(
        (value) =>
          value.maximumConcurrentWrites ?? 0,
      ),
    ),
    meanCasRetries: mean(
      diagnostics.map(
        (value) => value.casRetries ?? 0,
      ),
    ),
    meanStages: Object.fromEntries(
      [
        "writeLoadMs",
        "writePrepareMs",
        "writeIndexPrepareMs",
        "writeSnapshotCommitMs",
        "writeTreePipelineMs",
        "writeIndexCommitMs",
        "writeImmutablePipelineMs",
        "writeHeadCommitMs",
        "writeTotalMs",
      ].map((name) => [
        name,
        mean(
          diagnostics.map(
            (value) => value[name] ?? 0,
          ),
        ),
      ]),
    ),
    failures: failureCounts(samples),
  };
}

function aggregateReads(selected) {
  const cases = {};
  for (const run of selected) {
    for (const [name, value] of Object.entries(
      run.result.reads,
    )) {
      cases[name] ??= [];
      cases[name].push(value);
    }
  }
  const summary = Object.fromEntries(
    Object.entries(cases).map(
      ([name, values]) => [
        name,
        {
          successful: values.filter(
            (value) => value.success,
          ).length,
          total: values.length,
          pointP50Ms: percentile(
            sorted(
              values.map(
                (value) =>
                  value.point.elapsedMs,
              ),
            ),
            0.5,
          ),
          pointP95Ms: percentile(
            sorted(
              values.map(
                (value) =>
                  value.point.elapsedMs,
              ),
            ),
            0.95,
          ),
          meanPointReads: mean(
            values.map(
              (value) =>
                value.point.remoteReads,
            ),
          ),
          meanPointBytes: Math.round(
            mean(
              values.map(
                (value) =>
                  value.point.remoteBytes,
              ),
            ),
          ),
          queryP50Ms: percentile(
            sorted(
              values.map(
                (value) =>
                  value.query.elapsedMs,
              ),
            ),
            0.5,
          ),
          queryP95Ms: percentile(
            sorted(
              values.map(
                (value) =>
                  value.query.elapsedMs,
              ),
            ),
            0.95,
          ),
          meanQueryReads: mean(
            values.map(
              (value) =>
                value.query.remoteReads,
            ),
          ),
          meanQueryBytes: Math.round(
            mean(
              values.map(
                (value) =>
                  value.query.remoteBytes,
              ),
            ),
          ),
        },
      ],
    ),
  );
  return {
    cases: summary,
    comparisons: Object.fromEntries(
      PARALLEL_WRITE_LAYOUTS.map((layout) => [
        layout,
        {
          point: compareRead(
            summary[`write-parallel-${layout}`],
            summary[
              `write-sequential-${layout}`
            ],
            "point",
          ),
          query: compareRead(
            summary[`write-parallel-${layout}`],
            summary[
              `write-sequential-${layout}`
            ],
            "query",
          ),
        },
      ]),
    ),
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
    successRatePointChange:
      candidate.successRatePercent -
      baseline.successRatePercent,
  };
}

function compareRead(
  candidate,
  baseline,
  prefix,
) {
  return {
    p50ChangePercent: change(
      candidate[`${prefix}P50Ms`],
      baseline[`${prefix}P50Ms`],
    ),
    p95ChangePercent: change(
      candidate[`${prefix}P95Ms`],
      baseline[`${prefix}P95Ms`],
    ),
    readCountChangePercent: change(
      candidate[
        `mean${capitalize(prefix)}Reads`
      ],
      baseline[
        `mean${capitalize(prefix)}Reads`
      ],
    ),
    byteChangePercent: change(
      candidate[
        `mean${capitalize(prefix)}Bytes`
      ],
      baseline[
        `mean${capitalize(prefix)}Bytes`
      ],
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

function capitalize(value) {
  return (
    value.slice(0, 1).toUpperCase() +
    value.slice(1)
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
