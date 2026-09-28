import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_REGIONS,
  MUTATION_BATCH_ACCEPTANCE,
  MUTATION_BATCH_LAYOUTS,
  MUTATION_BATCH_SIZES,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_MUTATION_BATCH_OUTPUT ??
    ".bench-data/mutation-batching-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_MUTATION_BATCH_EVIDENCE ??
    "evidence/mutation-batching-regional-worker-2026-09-28.json",
);
const replicates = (
  process.env.THIMBLE_MUTATION_BATCH_REPLICATES ??
    "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
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

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit: manifest.sourceCommit,
  harnessCommits: unique(
    runs.map((run) => run.result.harnessCommit),
  ),
  target:
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionChanged: false,
  profile: manifest.profile,
  documents: manifest.documents,
  indexSet: manifest.indexSet,
  indexes: manifest.indexes,
  layouts: manifest.layouts,
  batchSizes: manifest.batchSizes,
  strategies: manifest.strategies,
  acceptance: MUTATION_BATCH_ACCEPTANCE,
  methodology: {
    execution:
      "Disposable Azure Node 22 callers compared sequential ordinary HTTP writes with one authoritative putMany commit against isolated R2 prefixes.",
    regions: BENCHMARK_REGIONS,
    replicates: replicates.length,
    iterationsPerCase:
      runs[0]?.result.iterations ?? 0,
    matrix:
      "25,000 documents, two covering indexes, Snapshot and Trie, and logical groups of 1, 5, and 20 mutations.",
    primaryLatency:
      "clientElapsedMs measured one complete logical mutation group. Read-your-writes verification ran after the timer.",
    durability:
      "Every successful write awaited immutable objects and final conditional HEAD publication.",
  },
  limitations: [
    "The regional matrix focuses on the large two-index profile after a broader local preflight.",
    "The separate-write control runs sequential HTTP requests from one caller and does not model concurrent browser requests.",
    "The benchmark does not include an application-level coalescing delay.",
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Authentication and browser rendering were excluded.",
    "Cloudflare Worker timers do not measure CPU-only work normally.",
  ],
  totals: {
    logicalOperations: Object.values(cases).reduce(
      (total, samples) =>
        total + samples.length,
      0,
    ),
    documentsAttempted: Object.values(cases)
      .flat()
      .reduce(
        (total, sample) =>
          total + sample.documents,
        0,
      ),
    runs: runs.length,
  },
  overall: {
    cases: summaries,
    comparisons,
    accepted: Object.values(comparisons).every(
      (comparison) => comparison.accepted,
    ),
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
  accepted: evidence.overall.accepted,
  comparisons: evidence.overall.comparisons,
}, null, 2));

async function loadRuns() {
  const loaded = [];
  for (const replicate of replicates) {
    for (const region of BENCHMARK_REGIONS) {
      const file = path.join(
        root,
        "results",
        `mutation-${replicate}`,
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
    (sample) => sample.success === true,
  );
  const elapsed = sorted(
    successful.map(
      (sample) => sample.clientElapsedMs,
    ),
  );
  const perDocument = sorted(
    successful.map(
      (sample) =>
        sample.clientElapsedMs /
        sample.documents,
    ),
  );
  return {
    logicalOperations: samples.length,
    documentsAttempted: samples.reduce(
      (total, sample) =>
        total + sample.documents,
      0,
    ),
    successful: successful.length,
    failed: samples.length - successful.length,
    successRatePercent: percent(
      successful.length,
      samples.length,
    ),
    clientP50Ms: percentile(elapsed, 0.5),
    clientP95Ms: percentile(elapsed, 0.95),
    clientMeanMs: mean(elapsed),
    perDocumentP50Ms:
      percentile(perDocument, 0.5),
    perDocumentP95Ms:
      percentile(perDocument, 0.95),
    workerMeanMs: mean(
      successful.map(
        (sample) =>
          sample.workerIoTimerMs ?? 0,
      ),
    ),
    verificationMeanMs: mean(
      successful.map(
        (sample) =>
          sample.verificationElapsedMs ?? 0,
      ),
    ),
    meanReads: mean(
      successful.map(
        (sample) =>
          sample.storage.reads.count,
      ),
    ),
    meanReadsPerDocument: mean(
      successful.map(
        (sample) =>
          sample.storage.reads.count /
          sample.documents,
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
    meanReadBytesPerDocument: Math.round(
      mean(
        successful.map(
          (sample) =>
            sample.storage.reads.bytes /
            sample.documents,
        ),
      ),
    ),
    meanWrites: mean(
      successful.map(
        (sample) =>
          sample.storage.writes.count,
      ),
    ),
    meanWritesPerDocument: mean(
      successful.map(
        (sample) =>
          sample.storage.writes.count /
          sample.documents,
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
    meanWriteBytesPerDocument: Math.round(
      mean(
        successful.map(
          (sample) =>
            sample.storage.writes.bytes /
            sample.documents,
        ),
      ),
    ),
    meanHeadWrites: mean(
      successful.map(
        (sample) =>
          sample.storage.byKind.head
            ?.writes.count ?? 0,
      ),
    ),
    meanIndexWrites: mean(
      successful.map(
        (sample) =>
          sample.storage.byKind.index
            ?.writes.count ?? 0,
      ),
    ),
    meanCasRetries: mean(
      successful.map(
        (sample) =>
          sample.diagnostics?.casRetries ??
            0,
      ),
    ),
    verificationFailures:
      samples.filter(
        (sample) =>
          sample.verificationPassed !== true,
      ).length,
    byKind: aggregateKinds(successful),
    failures: failureCounts(samples),
  };
}

function buildComparisons(summary) {
  const result = {};
  for (const layout of MUTATION_BATCH_LAYOUTS) {
    for (const batchSize of MUTATION_BATCH_SIZES) {
      const individual =
        summary[
          `mutation-${layout}-batch-${batchSize}-individual`
        ];
      const batch =
        summary[
          `mutation-${layout}-batch-${batchSize}-batch`
        ];
      if (!individual || !batch) {
        continue;
      }
      const comparison = {
        totalP50ChangePercent: change(
          batch.clientP50Ms,
          individual.clientP50Ms,
        ),
        totalP95ChangePercent: change(
          batch.clientP95Ms,
          individual.clientP95Ms,
        ),
        perDocumentP50ChangePercent: change(
          batch.perDocumentP50Ms,
          individual.perDocumentP50Ms,
        ),
        perDocumentP95ChangePercent: change(
          batch.perDocumentP95Ms,
          individual.perDocumentP95Ms,
        ),
        readCountPerDocumentChangePercent:
          change(
            batch.meanReadsPerDocument,
            individual.meanReadsPerDocument,
          ),
        readBytesPerDocumentChangePercent:
          change(
            batch.meanReadBytesPerDocument,
            individual.meanReadBytesPerDocument,
          ),
        writeCountPerDocumentChangePercent:
          change(
            batch.meanWritesPerDocument,
            individual.meanWritesPerDocument,
          ),
        writeBytesPerDocumentChangePercent:
          change(
            batch.meanWriteBytesPerDocument,
            individual.meanWriteBytesPerDocument,
          ),
        individualMeanHeadWrites:
          individual.meanHeadWrites,
        batchMeanHeadWrites:
          batch.meanHeadWrites,
        individualFailures: individual.failed,
        batchFailures: batch.failed,
        individualVerificationFailures:
          individual.verificationFailures,
        batchVerificationFailures:
          batch.verificationFailures,
      };
      comparison.accepted =
        comparison.batchVerificationFailures === 0 &&
        comparison.batchFailures === 0 &&
        comparison.batchMeanHeadWrites === 1 &&
        (batchSize === 1
          ? Math.abs(
              comparison.perDocumentP50ChangePercent,
            ) <= 20
          : comparison.perDocumentP50ChangePercent <=
            MUTATION_BATCH_ACCEPTANCE[
              batchSize
            ]);
      result[
        `${layout}-batch-${batchSize}`
      ] = comparison;
    }
  }
  return result;
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

function failureCounts(samples) {
  const failures = {};
  for (const sample of samples) {
    for (const message of [
      ...(sample.writeErrors ?? []),
      ...(sample.verificationError
        ? [sample.verificationError]
        : []),
    ]) {
      failures[message] =
        (failures[message] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(failures).sort(
      ([left], [right]) =>
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
