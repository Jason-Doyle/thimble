import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.env.THIMBLE_REGIONAL_OUTPUT ??
    ".bench-data/indexed-segment-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_REGIONAL_EVIDENCE ??
    "evidence/indexed-segment-regional-worker-2026-09-25.json",
);
const regions = [
  "eastus",
  "northeurope",
  "southeastasia",
  "australiaeast",
  "brazilsouth",
];
const replicates = [
  {
    name: "a",
    directory: path.join(root, "results-worker"),
  },
  {
    name: "b",
    directory: path.join(root, "results-worker-b"),
  },
];
const runs = [];

for (const replicate of replicates) {
  for (const region of regions) {
    const result = JSON.parse(
      await readFile(
        path.join(replicate.directory, `${region}.json`),
        "utf8",
      ),
    );
    runs.push({
      replicate: replicate.name,
      region,
      result,
    });
  }
}

const regionSummaries = Object.fromEntries(
  regions.map((region) => [
    region,
    aggregateRuns(
      runs.filter((run) => run.region === region),
    ),
  ]),
);
const overall = aggregateRuns(runs);

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit:
    process.env.THIMBLE_BENCHMARK_HARNESS_COMMIT ??
    "3b58f9b3ae2cd6ea2d7ae805d91559f92c7d3cc5",
  target:
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionWebsiteChanged: false,
  documents: 50_000,
  methodology: {
    execution:
      "Every measured storage read, range selection, decryption, decompression, parsing, lookup, and filtering operation executed inside the Cloudflare Worker.",
    regionalCallers:
      "Disposable Azure Container Instances only invoked the Worker and measured request round-trip time.",
    regions,
    replicates: replicates.length,
    perRegionPerReplicate: {
      coldPointPerFormat: 24,
      queryPerFormat: 8,
      fullScanPerFormat: 4,
    },
    formats: {
      experimental:
        "Encrypted TIS1 segment with 64 KiB suffix prefetch, sharded 64-bit HMAC ID index, coalesced block ranges, Bloom filters, and zone maps.",
      snapshot:
        "Current encrypted immutable snapshot layout.",
      trie:
        "Current encrypted content-addressed trie layout.",
      bundle:
        "Current trie read-bundle work performed inside the Worker.",
    },
    primaryLatency:
      "clientElapsedMs, measured by the regional cloud caller around one Worker request",
    secondaryTimer:
      "workerElapsedMs is retained but is not treated as complete CPU or wall time because production Worker timers advance around I/O and do not measure CPU-only sections normally.",
  },
  limitations: [
    "Azure regions approximate geography and do not represent residential last-mile networks.",
    "The regional caller includes Azure-to-Cloudflare network time, while all database work runs inside the Worker.",
    "The benchmark uses one Cloudflare account and one R2 bucket placement.",
    "The Worker and R2 objects may become warm during a replicate.",
    "The benchmark does not measure writes, compaction, cost, or concurrent writers.",
    "The experimental and snapshot query comparison returns complete documents and uses the same synthetic data.",
  ],
  overall,
  regions: regionSummaries,
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
  overall,
}, null, 2));

function aggregateRuns(selectedRuns) {
  const pointCases = [
    "point-manifested",
    "point-experimental",
    "point-snapshot",
    "point-trie",
    "point-bundle",
  ];
  const queryCases = {
    clusteredEquality: [
      "clustered-manifested",
      "clustered-experimental",
      "clustered-snapshot",
    ],
    narrowRange: [
      "range-manifested",
      "range-experimental",
      "range-snapshot",
    ],
    distributedEquality: [
      "distributed-manifested",
      "distributed-experimental",
      "distributed-snapshot",
    ],
    fullScan: [
      "scan-manifested",
      "scan-experimental",
      "scan-snapshot",
    ],
  };
  const point = Object.fromEntries(
    pointCases.map((caseName) => [
      caseName,
      summarise(
        selectedRuns.flatMap(
          (run) =>
            run.result.coldPointSamples[caseName],
        ),
      ),
    ]),
  );
  const queries = Object.fromEntries(
    Object.entries(queryCases).map(([group, cases]) => [
      group,
      Object.fromEntries(
        cases.map((caseName) => [
          caseName,
          summarise(
            selectedRuns.flatMap(
              (run) =>
                run.result.queries[group].samples[caseName],
            ),
          ),
        ]),
      ),
    ]),
  );
  return {
    point,
    queries,
    comparisons: {
      pointManifestedVsSnapshot: compare(
        point["point-manifested"],
        point["point-snapshot"],
      ),
      pointManifestedVsTis1: compare(
        point["point-manifested"],
        point["point-experimental"],
      ),
      pointExperimentalVsSnapshot: compare(
        point["point-experimental"],
        point["point-snapshot"],
      ),
      pointExperimentalVsTrie: compare(
        point["point-experimental"],
        point["point-trie"],
      ),
      pointExperimentalVsBundle: compare(
        point["point-experimental"],
        point["point-bundle"],
      ),
      clusteredExperimentalVsSnapshot: compare(
        queries.clusteredEquality["clustered-experimental"],
        queries.clusteredEquality["clustered-snapshot"],
      ),
      clusteredManifestedVsSnapshot: compare(
        queries.clusteredEquality["clustered-manifested"],
        queries.clusteredEquality["clustered-snapshot"],
      ),
      clusteredManifestedVsTis1: compare(
        queries.clusteredEquality["clustered-manifested"],
        queries.clusteredEquality[
          "clustered-experimental"
        ],
      ),
      rangeExperimentalVsSnapshot: compare(
        queries.narrowRange["range-experimental"],
        queries.narrowRange["range-snapshot"],
      ),
      rangeManifestedVsSnapshot: compare(
        queries.narrowRange["range-manifested"],
        queries.narrowRange["range-snapshot"],
      ),
      rangeManifestedVsTis1: compare(
        queries.narrowRange["range-manifested"],
        queries.narrowRange["range-experimental"],
      ),
      distributedExperimentalVsSnapshot: compare(
        queries.distributedEquality[
          "distributed-experimental"
        ],
        queries.distributedEquality[
          "distributed-snapshot"
        ],
      ),
      distributedManifestedVsSnapshot: compare(
        queries.distributedEquality[
          "distributed-manifested"
        ],
        queries.distributedEquality[
          "distributed-snapshot"
        ],
      ),
      scanExperimentalVsSnapshot: compare(
        queries.fullScan["scan-experimental"],
        queries.fullScan["scan-snapshot"],
      ),
      scanManifestedVsSnapshot: compare(
        queries.fullScan["scan-manifested"],
        queries.fullScan["scan-snapshot"],
      ),
    },
  };
}

function summarise(samples) {
  const client = samples
    .map((sample) => sample.clientElapsedMs)
    .sort((left, right) => left - right);
  const worker = samples
    .map((sample) => sample.workerElapsedMs)
    .sort((left, right) => left - right);
  return {
    operations: samples.length,
    clientP50Ms: percentile(client, 0.5),
    clientP95Ms: percentile(client, 0.95),
    clientMeanMs: mean(client),
    workerIoTimerP50Ms: percentile(worker, 0.5),
    workerIoTimerP95Ms: percentile(worker, 0.95),
    meanStorageReads: mean(
      samples.map((sample) => sample.storageReads),
    ),
    meanStorageBytes: Math.round(
      mean(samples.map((sample) => sample.storageBytes)),
    ),
    documents: samples[0]?.documents ?? 0,
    colos: [
      ...new Set(
        samples
          .map((sample) => sample.colo)
          .filter(Boolean),
      ),
    ].sort(),
  };
}

function compare(experimental, baseline) {
  return {
    p50ChangePercent: change(
      experimental.clientP50Ms,
      baseline.clientP50Ms,
    ),
    p95ChangePercent: change(
      experimental.clientP95Ms,
      baseline.clientP95Ms,
    ),
    storageBytesChangePercent: change(
      experimental.meanStorageBytes,
      baseline.meanStorageBytes,
    ),
    storageReadsChangePercent: change(
      experimental.meanStorageReads,
      baseline.meanStorageReads,
    ),
  };
}

function change(value, baseline) {
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
  return Number(
    (
      values.reduce((total, value) => total + value, 0) /
      values.length
    ).toFixed(3),
  );
}
