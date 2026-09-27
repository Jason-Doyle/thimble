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

class CountingStore {
  objects = new Map();
  etag = 0;
  reads = 0;
  readBytes = 0;
  writes = 0;
  writeBytes = 0;
  preconditionFailures = 0;

  get(key) {
    const object = this.objects.get(key);
    this.reads += 1;
    this.readBytes += object?.bytes.byteLength ?? 0;
    return Promise.resolve(
      object
        ? {
            bytes: object.bytes.slice(),
            etag: object.etag,
          }
        : null,
    );
  }

  put(key, bytes, conditions = {}) {
    const current = this.objects.get(key);
    if (
      (conditions.ifNoneMatch && current) ||
      (conditions.ifMatch !== undefined &&
        current?.etag !== conditions.ifMatch)
    ) {
      this.preconditionFailures += 1;
      return Promise.reject(
        new PreconditionFailedError("etag"),
      );
    }
    const etag = String(++this.etag);
    this.objects.set(key, {
      bytes: bytes.slice(),
      etag,
    });
    this.writes += 1;
    this.writeBytes += bytes.byteLength;
    return Promise.resolve({ etag });
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

  reset() {
    this.reads = 0;
    this.readBytes = 0;
    this.writes = 0;
    this.writeBytes = 0;
    this.preconditionFailures = 0;
  }
}

const documents = Number(
  process.env.THIMBLE_PARTITIONED_DOCUMENTS ?? "25000",
);
const iterations = Number(
  process.env.THIMBLE_PARTITIONED_ITERATIONS ?? "6",
);
const partitionCount = Number(
  process.env.THIMBLE_PARTITIONED_SHARDS ?? "4",
);
const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 91,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const initial = benchmarkDocuments(documents);
const configurations = [
  { name: "snapshot-baseline", layout: "snapshot", partitions: null },
  { name: "snapshot-partitioned", layout: "snapshot", partitions: partitionCount },
  { name: "trie-baseline", layout: "trie", partitions: null },
  { name: "trie-partitioned", layout: "trie", partitions: partitionCount },
];
const results = {};

for (const configuration of configurations) {
  const raw = new CountingStore();
  const store = new EnvelopeObjectStore(raw, {
    key,
    keyId: "partitioned-local-v1",
    compression: "gzip",
  });
  const partitionConfiguration = configuration.partitions
    ? {
        notes: Object.fromEntries(
          BENCHMARK_INDEXES.notes.map((definition) => [
            definition.name,
            configuration.partitions,
          ]),
        ),
      }
    : {};
  const engine =
    configuration.layout === "snapshot"
      ? new ImmutableSnapshotEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
          false,
          partitionConfiguration,
        )
      : new ContentAddressedTrieEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
          false,
          partitionConfiguration,
        );
  await engine.putMany("notes", initial);
  const storedObjects = raw.objects.size;
  const storedBytes = [...raw.objects.values()].reduce(
    (total, object) => total + object.bytes.byteLength,
    0,
  );
  raw.reset();
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const index = (iteration * 997) % documents;
    const document = {
      ...initial[index],
      body: `${initial[index].body} update ${iteration}`,
      lastModified: documents + iteration,
    };
    const started = performance.now();
    await engine.put("notes", document.id, document);
    samples.push({
      elapsedMs: round(performance.now() - started),
      reads: raw.reads,
      readBytes: raw.readBytes,
      writes: raw.writes,
      writeBytes: raw.writeBytes,
      preconditionFailures: raw.preconditionFailures,
    });
    raw.reset();
  }
  results[configuration.name] = {
    storedObjects,
    storedBytes,
    summary: summarise(samples),
    samples,
  };
}

const output = {
  generatedAt: new Date().toISOString(),
  sourceCommit:
    process.env.THIMBLE_BENCHMARK_SOURCE_COMMIT ?? null,
  documents,
  iterations,
  partitionCount,
  warning:
    "Local in-memory object-store preflight. Regional cloud evidence remains authoritative for latency.",
  results,
};
await mkdir("benchmark-results", { recursive: true });
const outputPath = path.resolve(
  "benchmark-results",
  `partitioned-index-${Date.now()}.json`,
);
await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
console.log(`Raw result: ${outputPath}`);

function summarise(samples) {
  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    meanMs: mean(elapsed),
    meanReads: mean(samples.map((sample) => sample.reads)),
    meanReadBytes: Math.round(
      mean(samples.map((sample) => sample.readBytes)),
    ),
    meanWrites: mean(samples.map((sample) => sample.writes)),
    meanWriteBytes: Math.round(
      mean(samples.map((sample) => sample.writeBytes)),
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
      values.reduce((total, value) => total + value, 0) /
      values.length
    ).toFixed(3),
  );
}

function round(value) {
  return Number(value.toFixed(3));
}
