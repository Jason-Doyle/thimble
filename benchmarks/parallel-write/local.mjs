import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  PreconditionFailedError,
} from "../../src/core.ts";
import {
  ContentAddressedTrieEngine,
} from "../../src/engines/content-trie.ts";
import {
  ImmutableSnapshotEngine,
} from "../../src/engines/immutable-snapshot.ts";
import { EnvelopeObjectStore } from "../../src/envelope-store.ts";
import {
  importAesGcmKey,
} from "../../src/envelope.ts";
import {
  BENCHMARK_INDEXES,
  benchmarkDocuments,
} from "../current-regional/scenario.ts";

const profiles = [
  { name: "small", documents: 128 },
  { name: "medium", documents: 5_000 },
  { name: "large", documents: 25_000 },
];
const indexSets = [
  { name: "zero-indexes", indexes: {} },
  {
    name: "one-index",
    indexes: {
      notes: [
        BENCHMARK_INDEXES.notes[0],
      ],
    },
  },
  {
    name: "two-indexes",
    indexes: BENCHMARK_INDEXES,
  },
];
const layouts = ["snapshot", "trie"];
const modes = ["sequential", "parallel"];
const iterations = Number(
  process.env.THIMBLE_PARALLEL_WRITE_ITERATIONS ??
    "4",
);
const latencyMs = Number(
  process.env.THIMBLE_PARALLEL_WRITE_LATENCY_MS ??
    "8",
);

async function main() {
const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 111,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const results = {};

for (const profile of profiles) {
  const documents = benchmarkDocuments(
    profile.documents,
  );
  for (const indexSet of indexSets) {
    for (const layout of layouts) {
      for (const mode of modes) {
        const raw = new CountingDelayedStore();
        const store = new EnvelopeObjectStore(raw, {
          key,
          keyId: "parallel-write-local-v1",
          compression: "gzip",
        });
        const options = {
          mode,
          maximumConcurrency: 3,
        };
        const engine =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                undefined,
                false,
                indexSet.indexes,
                false,
                options,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                undefined,
                false,
                indexSet.indexes,
                false,
                options,
              );
        await engine.putMany("notes", documents);
        const storedObjects = raw.objects.size;
        const storedBytes = [...raw.objects.values()]
          .reduce(
            (total, object) =>
              total + object.bytes.byteLength,
            0,
          );
        raw.delayMs = latencyMs;
        raw.resetMetrics();
        const samples = [];
        for (
          let iteration = 0;
          iteration < iterations;
          iteration += 1
        ) {
          const index =
            (iteration * 997) %
            profile.documents;
          const document = {
            ...documents[index],
            body:
              `${documents[index].body} update ` +
              iteration,
            lastModified:
              profile.documents + iteration,
          };
          const started = performance.now();
          await engine.put(
            "notes",
            document.id,
            document,
          );
          samples.push({
            elapsedMs: round(
              performance.now() - started,
            ),
            reads: raw.reads,
            readBytes: raw.readBytes,
            writes: raw.writes,
            writeBytes: raw.writeBytes,
            maximumConcurrentReads:
              raw.maximumConcurrentReads,
            maximumConcurrentWrites:
              raw.maximumConcurrentWrites,
            diagnostics: engine.diagnostics(),
          });
          raw.resetMetrics();
        }
        results[
          [
            profile.name,
            indexSet.name,
            layout,
            mode,
          ].join("-")
        ] = {
          profile: profile.name,
          documents: profile.documents,
          indexSet: indexSet.name,
          indexCount:
            indexSet.indexes.notes?.length ?? 0,
          layout,
          mode,
          storedObjects,
          storedBytes,
          summary: summarise(samples),
          samples,
        };
      }
    }
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  sourceCommit:
    process.env.THIMBLE_BENCHMARK_SOURCE_COMMIT ??
      null,
  iterations,
  simulatedObjectLatencyMs: latencyMs,
  warning:
    "Local in-memory object store with fixed operation latency. Regional cloud evidence remains authoritative.",
  results,
};
await mkdir("benchmark-results", {
  recursive: true,
});
const outputPath = path.resolve(
  "benchmark-results",
  `parallel-write-${Date.now()}.json`,
);
await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify({
  outputPath,
  comparisons: comparisons(results),
}, null, 2));
}

function comparisons(values) {
  const compared = {};
  for (const candidate of Object.values(values)) {
    if (candidate.mode !== "parallel") {
      continue;
    }
    const baseline = values[
      [
        candidate.profile,
        candidate.indexSet,
        candidate.layout,
        "sequential",
      ].join("-")
    ];
    compared[
      [
        candidate.profile,
        candidate.indexSet,
        candidate.layout,
      ].join("-")
    ] = {
      p50ChangePercent: change(
        candidate.summary.p50Ms,
        baseline.summary.p50Ms,
      ),
      p95ChangePercent: change(
        candidate.summary.p95Ms,
        baseline.summary.p95Ms,
      ),
      readCountChangePercent: change(
        candidate.summary.meanReads,
        baseline.summary.meanReads,
      ),
      writeCountChangePercent: change(
        candidate.summary.meanWrites,
        baseline.summary.meanWrites,
      ),
      writeBytesChangePercent: change(
        candidate.summary.meanWriteBytes,
        baseline.summary.meanWriteBytes,
      ),
    };
  }
  return compared;
}

function summarise(samples) {
  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    meanMs: mean(elapsed),
    meanReads: mean(
      samples.map((sample) => sample.reads),
    ),
    meanReadBytes: Math.round(
      mean(
        samples.map(
          (sample) => sample.readBytes,
        ),
      ),
    ),
    meanWrites: mean(
      samples.map((sample) => sample.writes),
    ),
    meanWriteBytes: Math.round(
      mean(
        samples.map(
          (sample) => sample.writeBytes,
        ),
      ),
    ),
    maximumConcurrentReads: Math.max(
      ...samples.map(
        (sample) =>
          sample.maximumConcurrentReads,
      ),
    ),
    maximumConcurrentWrites: Math.max(
      ...samples.map(
        (sample) =>
          sample.maximumConcurrentWrites,
      ),
    ),
  };
}

function percentile(values, quantile) {
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
      values.reduce(
        (total, value) => total + value,
        0,
      ) / values.length
    ).toFixed(3),
  );
}

function change(value, baseline) {
  return Number(
    (((value - baseline) / baseline) * 100)
      .toFixed(2),
  );
}

function round(value) {
  return Number(value.toFixed(3));
}

class CountingDelayedStore {
  objects = new Map();
  etag = 0;
  delayMs = 0;
  reads = 0;
  readBytes = 0;
  writes = 0;
  writeBytes = 0;
  activeReads = 0;
  activeWrites = 0;
  maximumConcurrentReads = 0;
  maximumConcurrentWrites = 0;

  async get(key) {
    this.activeReads += 1;
    this.maximumConcurrentReads = Math.max(
      this.maximumConcurrentReads,
      this.activeReads,
    );
    try {
      await delay(this.delayMs);
      const object = this.objects.get(key);
      this.reads += 1;
      this.readBytes +=
        object?.bytes.byteLength ?? 0;
      return object
        ? {
            bytes: object.bytes.slice(),
            etag: object.etag,
          }
        : null;
    } finally {
      this.activeReads -= 1;
    }
  }

  async put(key, bytes, conditions = {}) {
    this.activeWrites += 1;
    this.maximumConcurrentWrites = Math.max(
      this.maximumConcurrentWrites,
      this.activeWrites,
    );
    try {
      await delay(this.delayMs);
      const current = this.objects.get(key);
      if (
        (conditions.ifNoneMatch && current) ||
        (conditions.ifMatch !== undefined &&
          current?.etag !== conditions.ifMatch)
      ) {
        throw new PreconditionFailedError(key);
      }
      const etag = String(++this.etag);
      this.objects.set(key, {
        bytes: bytes.slice(),
        etag,
      });
      this.writes += 1;
      this.writeBytes += bytes.byteLength;
      return { etag };
    } finally {
      this.activeWrites -= 1;
    }
  }

  delete(key) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix) {
    return Promise.resolve(
      [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(),
    );
  }

  resetMetrics() {
    this.reads = 0;
    this.readBytes = 0;
    this.writes = 0;
    this.writeBytes = 0;
    this.activeReads = 0;
    this.activeWrites = 0;
    this.maximumConcurrentReads = 0;
    this.maximumConcurrentWrites = 0;
  }
}

function delay(milliseconds) {
  return milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) =>
        setTimeout(resolve, milliseconds),
      );
}

await main();
