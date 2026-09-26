import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_OUTPUT ??
    ".bench-data/current-regional",
);
const outputPath = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_EVIDENCE ??
    "evidence/r2-current-layout-multiregion-2026-09-25.json",
);
const replicateNames = (
  process.env.THIMBLE_CURRENT_REGIONAL_REPLICATES ??
  "a,b"
).split(",").map((value) => value.trim()).filter(Boolean);
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);

const readRuns = await loadRuns("read");
const writeRuns = await loadRuns("write");
const contentionRuns = await loadRuns("contention");
const evidence = {
  generatedAt: new Date().toISOString(),
  sourceCommit: manifest.sourceCommit,
  harnessCommit: manifest.harnessCommit,
  target:
    "temporary workers.dev Worker and temporary Cloudflare R2 bucket",
  productionWebsiteChangedDuringMeasurement: false,
  profiles: Object.fromEntries(
    Object.entries(manifest.profiles).map(
      ([name, profile]) => [
        name,
        {
          documents: profile.documents,
          decodedSnapshotBytes: profile.decodedSnapshotBytes,
          layouts: profile.layouts,
          expected: profile.expected,
        },
      ],
    ),
  ),
  decodedObjectLimit: manifest.decodedObjectLimit,
  methodology: {
    execution:
      "Disposable Azure Node 22 clients used the production ThimbleDB browser read planner over HTTPS. TDB1 object reads, decryption, decompression, caching, index planning, and result validation used the current package code. Writes executed inside the temporary Cloudflare Worker against R2.",
    regions: BENCHMARK_REGIONS,
    replicates: replicateNames.length,
    perRegionPerReplicate: {
      pointPerCasePerProfile: 12,
      queryPerCasePerProfile: 5,
      scanPerCasePerProfile: 2,
      singleWriterPerLayout: 8,
      contendedWriterPerLayout: 5,
    },
    layouts: {
      snapshot:
        "Current encrypted immutable snapshot plus two declared secondary indexes.",
      trie:
        "Current encrypted two-level content-addressed trie plus two declared secondary indexes.",
      bundle:
        "Current bounded authority-side point-read bundle, limited to four objects and 4 MiB decoded.",
    },
    indexes: manifest.profiles.large
      ? {
          equality:
            "category equality with title and lastModified covering fields",
          range:
            "lastModified range with title and category covering fields",
        }
      : null,
    primaryLatency:
      "clientElapsedMs measured by the regional Azure caller around the complete operation",
    writeTimer:
      "workerIoTimerMs is retained only as a secondary I/O-oriented timer",
  },
  limitations: [
    "Azure regions approximate client geography and do not represent residential last-mile networks.",
    "The temporary benchmark omitted OIDC login and production application rendering.",
    "Node 22 executed the browser client code, so IndexedDB and browser scheduling were not measured.",
    "One Cloudflare account and one R2 bucket placement were used.",
    "Absolute latency varies with routing, platform load, and time of day.",
    "The synthetic workload does not establish superiority over another database.",
  ],
  totals: {
    measuredOperations:
      countReadOperations(readRuns) +
      countWriteOperations(writeRuns) +
      countWriteOperations(contentionRuns),
    readRuns: readRuns.length,
    writeRuns: writeRuns.length,
    contentionRuns: contentionRuns.length,
  },
  overall: {
    reads: aggregateReadRuns(readRuns),
    writes: aggregateWriteRuns(writeRuns),
    contention: aggregateWriteRuns(contentionRuns),
  },
  regions: Object.fromEntries(
    BENCHMARK_REGIONS.map((region) => [
      region,
      {
        reads: aggregateReadRuns(
          readRuns.filter((run) => run.region === region),
        ),
        writes: aggregateWriteRuns(
          writeRuns.filter((run) => run.region === region),
        ),
        contention: aggregateWriteRuns(
          contentionRuns.filter(
            (run) => run.region === region,
          ),
        ),
      },
    ]),
  ),
  runs: {
    reads: readRuns,
    writes: writeRuns,
    contention: contentionRuns,
  },
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
  for (const replicate of replicateNames) {
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
  const profiles = {};
  for (const profile of Object.keys(BENCHMARK_PROFILES)) {
    const samples = {
      point: collectReadSamples(runs, profile, "point"),
      queries: collectReadSamples(runs, profile, "queries"),
      scans: collectReadSamples(runs, profile, "scans"),
    };
    const point = summariseCases(samples.point);
    const queries = summariseCases(samples.queries);
    const scans = summariseCases(samples.scans);
    profiles[profile] = {
      point,
      queries,
      scans,
      comparisons: {
        pointSnapshotVsTrie: compare(
          point["point-snapshot"],
          point["point-trie"],
        ),
        bundleSnapshotVsDirect: compare(
          point["bundle-snapshot"],
          point["point-snapshot"],
        ),
        bundleTrieVsDirect: compare(
          point["bundle-trie"],
          point["point-trie"],
        ),
        coveredEqualitySnapshotVsTrie: compare(
          queries["covered-equality-snapshot"],
          queries["covered-equality-trie"],
        ),
        uncoveredEqualitySnapshotVsTrie: compare(
          queries["uncovered-equality-snapshot"],
          queries["uncovered-equality-trie"],
        ),
        coveredRangeSnapshotVsTrie: compare(
          queries["covered-range-snapshot"],
          queries["covered-range-trie"],
        ),
        coveredVsUncoveredSnapshot: compare(
          queries["covered-equality-snapshot"],
          queries["uncovered-equality-snapshot"],
        ),
        coveredVsUncoveredTrie: compare(
          queries["covered-equality-trie"],
          queries["uncovered-equality-trie"],
        ),
        scanSnapshotVsTrie: compare(
          scans["scan-snapshot"],
          scans["scan-trie"],
        ),
      },
    };
  }
  return profiles;
}

function collectReadSamples(runs, profile, group) {
  const collected = {};
  for (const run of runs) {
    const cases = run.result.profiles[profile][group];
    for (const [caseName, samples] of Object.entries(cases)) {
      collected[caseName] ??= [];
      collected[caseName].push(...samples);
    }
  }
  return collected;
}

function summariseCases(cases) {
  return Object.fromEntries(
    Object.entries(cases).map(([caseName, samples]) => [
      caseName,
      summariseRead(samples),
    ]),
  );
}

function summariseRead(samples) {
  const client = sorted(
    samples.map((sample) => sample.clientElapsedMs),
  );
  return {
    operations: samples.length,
    clientP50Ms: percentile(client, 0.5),
    clientP95Ms: percentile(client, 0.95),
    clientMeanMs: mean(client),
    meanNetworkReads: mean(
      samples.map((sample) => sample.networkReads),
    ),
    meanNetworkBytes: Math.round(
      mean(samples.map((sample) => sample.networkBytes)),
    ),
    meanObjectReads: mean(
      samples.map((sample) => sample.objectReads),
    ),
    meanObjectBytes: Math.round(
      mean(samples.map((sample) => sample.objectBytes)),
    ),
    meanDocuments: mean(
      samples.map((sample) => sample.documents),
    ),
    meanScannedDocuments: mean(
      samples.map((sample) => sample.scannedDocuments),
    ),
  };
}

function aggregateWriteRuns(runs) {
  const cases = {};
  for (const run of runs) {
    for (const [caseName, samples] of Object.entries(
      run.result.samples,
    )) {
      cases[caseName] ??= [];
      cases[caseName].push(...samples);
    }
  }
  const summary = Object.fromEntries(
    Object.entries(cases).map(([caseName, samples]) => [
      caseName,
      summariseWrites(samples),
    ]),
  );
  const snapshot =
    summary["write-snapshot"] ??
    summary["contention-snapshot"];
  const trie =
    summary["write-trie"] ??
    summary["contention-trie"];
  return {
    cases: summary,
    comparisons:
      snapshot && trie
        ? {
            snapshotVsTrie: compare(snapshot, trie),
          }
        : {},
  };
}

function summariseWrites(samples) {
  const successful = samples.filter(
    (sample) => sample.success !== false,
  );
  const client = sorted(
    successful.map((sample) => sample.clientElapsedMs),
  );
  const storage = successful.map(
    (sample) => sample.storage ?? {},
  );
  return {
    operations: samples.length,
    successful: successful.length,
    failed: samples.length - successful.length,
    successRatePercent: Number(
      ((successful.length / samples.length) * 100).toFixed(2),
    ),
    clientP50Ms: percentile(client, 0.5),
    clientP95Ms: percentile(client, 0.95),
    clientMeanMs: mean(client),
    meanObjectReads: mean(
      storage.map((value) => value.reads ?? 0),
    ),
    meanObjectBytesRead: Math.round(
      mean(storage.map((value) => value.readBytes ?? 0)),
    ),
    meanObjectWrites: mean(
      storage.map((value) => value.writes ?? 0),
    ),
    meanObjectBytesWritten: Math.round(
      mean(storage.map((value) => value.writtenBytes ?? 0)),
    ),
    meanPreconditionFailures: mean(
      storage.map(
        (value) => value.preconditionFailures ?? 0,
      ),
    ),
    meanCasRetries: mean(
      successful.map(
        (sample) => sample.diagnostics?.casRetries ?? 0,
      ),
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
    networkReadsChangePercent: change(
      candidate.meanNetworkReads ??
        candidate.meanObjectReads,
      baseline.meanNetworkReads ??
        baseline.meanObjectReads,
    ),
    networkBytesChangePercent: change(
      candidate.meanNetworkBytes ??
        candidate.meanObjectBytesWritten,
      baseline.meanNetworkBytes ??
        baseline.meanObjectBytesWritten,
    ),
  };
}

function countReadOperations(runs) {
  let count = 0;
  for (const run of runs) {
    for (const profile of Object.values(
      run.result.profiles,
    )) {
      for (const group of [
        profile.point,
        profile.queries,
        profile.scans,
      ]) {
        for (const samples of Object.values(group)) {
          count += samples.length;
        }
      }
    }
  }
  return count;
}

function countWriteOperations(runs) {
  let count = 0;
  for (const run of runs) {
    for (const samples of Object.values(
      run.result.samples,
    )) {
      count += samples.length;
    }
  }
  return count;
}

function change(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) {
    return null;
  }
  if (baseline === 0) {
    return value === 0 ? 0 : null;
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
