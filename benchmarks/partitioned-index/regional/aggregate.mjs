import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { BENCHMARK_REGIONS } from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_PARTITIONED_REGIONAL_OUTPUT ??
    ".bench-data/partitioned-index-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_PARTITIONED_REGIONAL_EVIDENCE ??
    "evidence/value-routed-index-regional-worker-2026-09-27.json",
);
const replicates = (
  process.env.THIMBLE_PARTITIONED_REPLICATES ?? "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const reads = await loadRuns("read");
const writes = await loadRuns("write");
const contention = await loadRuns("contention");
const allRuns = [...reads, ...writes, ...contention];

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit: manifest.sourceCommit,
  harnessCommits: unique(
    allRuns.map((run) => run.result.harnessCommit),
  ),
  target:
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionChanged: false,
  documents: manifest.documents,
  partitionCount: manifest.partitionCount,
  expected: manifest.expected,
  layouts: manifest.layouts,
  methodology: {
    execution:
      "Disposable Azure Node 22 clients ran current browser query planning over HTTPS. Writes executed inside the temporary Cloudflare Worker against R2.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    queryIterationsPerCase: 5,
    singleWriteIterationsPerCase: 8,
    contentionIterationsPerCase: 3,
    candidate:
      "Four immutable secondary-index partitions. Equality values select one hash partition; range predicates select only intersecting ordered partitions. Routing metadata is embedded atomically in the collection HEAD.",
    baseline:
      "Current one-page immutable secondary index per definition.",
    primaryLatency:
      "clientElapsedMs measured around the complete regional operation",
    fixtureIsolation:
      "Read fixtures were immutable. Single-writer regions used separate prefixes; replicates ran sequentially with a recreated empty bucket. Each contention replicate used one shared generation and a recreated empty bucket.",
    retainedRuns:
      "Only the final pinned read runs and pristine-bucket write and contention runs are included. Harness smoke tests and invalid preliminary runs were discarded.",
  },
  limitations: [
    "Equality-value hashing can create skew when a few values dominate the workload.",
    "Ordered range boundaries are static for this experiment and do not rebalance automatically.",
    "An indexed-value move can rewrite both the old and new partitions.",
    "The candidate is experimental and is not a public package export or production protocol.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Authentication and application rendering were excluded.",
    "The benchmark compares ThimbleDB index layouts, not another database.",
  ],
  totals: {
    operations:
      countOperations(reads) +
      countOperations(writes) +
      countOperations(contention),
    readRuns: reads.length,
    writeRuns: writes.length,
    contentionRuns: contention.length,
  },
  overall: {
    reads: aggregateReadRuns(reads),
    writes: aggregateWriteRuns(writes),
    contention: aggregateWriteRuns(contention),
  },
  regions: Object.fromEntries(
    BENCHMARK_REGIONS.map((region) => [
      region,
      {
        reads: aggregateReadRuns(
          reads.filter((run) => run.region === region),
        ),
        writes: aggregateWriteRuns(
          writes.filter((run) => run.region === region),
        ),
        contention: aggregateWriteRuns(
          contention.filter((run) => run.region === region),
        ),
      },
    ]),
  ),
  runs: { reads, writes, contention },
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

async function loadRuns(mode) {
  const runs = [];
  for (const replicate of replicates) {
    for (const region of BENCHMARK_REGIONS) {
      const file = path.join(
        root,
        "results",
        `${mode}-${replicate}`,
        `${region}.json`,
      );
      runs.push({
        replicate,
        region,
        result: JSON.parse(await readFile(file, "utf8")),
      });
    }
  }
  return runs;
}

function aggregateReadRuns(runs) {
  const cases = collectCases(runs);
  const summary = Object.fromEntries(
    Object.entries(cases).map(([name, samples]) => [
      name,
      summariseRead(samples),
    ]),
  );
  return {
    cases: summary,
    comparisons: Object.fromEntries(
      [
        "covered-equality",
        "uncovered-equality",
        "covered-range",
        "warm-requery",
      ].flatMap((operation) =>
        ["snapshot", "trie"].map((layout) => {
          const candidate =
            summary[`${operation}-value-routed-${layout}`];
          const baseline =
            summary[`${operation}-baseline-${layout}`];
          return [
            `${operation}-${layout}`,
            compare(candidate, baseline),
          ];
        }),
      ),
    ),
  };
}

function aggregateWriteRuns(runs) {
  const cases = collectCases(runs);
  const summary = Object.fromEntries(
    Object.entries(cases).map(([name, samples]) => [
      name,
      summariseWrite(samples),
    ]),
  );
  const prefix = Object.keys(summary).some((name) =>
    name.startsWith("contention-"),
  )
    ? "contention"
    : "write";
  return {
    cases: summary,
    comparisons: Object.fromEntries(
      ["snapshot", "trie"].map((layout) => [
        layout,
        compare(
          summary[`${prefix}-value-routed-${layout}`],
          summary[`${prefix}-baseline-${layout}`],
        ),
      ]),
    ),
  };
}

function collectCases(runs) {
  const cases = {};
  for (const run of runs) {
    for (const [name, samples] of Object.entries(
      run.result.samples,
    )) {
      cases[name] ??= [];
      cases[name].push(...samples);
    }
  }
  return cases;
}

function summariseRead(samples) {
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
    meanScannedDocuments: mean(
      successful.map((sample) => sample.scannedDocuments),
    ),
    failures: failureCounts(samples),
  };
}

function summariseWrite(samples) {
  const successful = samples.filter(
    (sample) => sample.success !== false,
  );
  const elapsed = sorted(
    successful.map((sample) => sample.clientElapsedMs),
  );
  const storage = successful.map(
    (sample) => sample.storage ?? {},
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
      mean(storage.map((value) => value.readBytes ?? 0)),
    ),
    meanWrites: mean(
      storage.map((value) => value.writes ?? 0),
    ),
    meanWriteBytes: Math.round(
      mean(storage.map((value) => value.writtenBytes ?? 0)),
    ),
    meanCasRetries: mean(
      successful.map(
        (sample) => sample.diagnostics?.casRetries ?? 0,
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
    readCountChangePercent: change(
      candidate.meanNetworkReads ?? candidate.meanReads,
      baseline.meanNetworkReads ?? baseline.meanReads,
    ),
    readBytesChangePercent: change(
      candidate.meanNetworkBytes ?? candidate.meanReadBytes,
      baseline.meanNetworkBytes ?? baseline.meanReadBytes,
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

function failureCounts(samples) {
  return Object.fromEntries(
    Object.entries(
      samples
        .filter((sample) => sample.success === false)
        .reduce((counts, sample) => {
          const error = sample.error ?? "Unknown error";
          counts[error] = (counts[error] ?? 0) + 1;
          return counts;
        }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countOperations(runs) {
  return runs.reduce(
    (total, run) =>
      total +
      Object.values(run.result.samples).reduce(
        (runTotal, samples) =>
          runTotal + samples.length,
        0,
      ),
    0,
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

function percent(value, total) {
  return total === 0
    ? 0
    : Number(((value / total) * 100).toFixed(2));
}

function unique(values) {
  return [
    ...new Set(values.filter(Boolean)),
  ].sort();
}
