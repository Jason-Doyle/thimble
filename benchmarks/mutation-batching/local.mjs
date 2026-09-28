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
  BENCHMARK_PROFILES,
  MUTATION_BATCH_SIZES,
  WRITE_SCALING_INDEX_SETS,
  WRITE_SCALING_LAYOUTS,
  benchmarkDocuments,
} from "./regional/scenario.ts";

const iterations = Number(
  process.env.THIMBLE_MUTATION_BATCH_ITERATIONS ??
    "2",
);

async function main() {
  const rawKey = Uint8Array.from(
    { length: 32 },
    (_, index) => index + 151,
  );
  const key = await importAesGcmKey(
    rawKey,
    ["encrypt", "decrypt"],
  );
  const results = {};

  for (const [profile, count] of Object.entries(
    BENCHMARK_PROFILES,
  )) {
    const documents = benchmarkDocuments(count);
    for (const [indexSet, indexes] of Object.entries(
      WRITE_SCALING_INDEX_SETS,
    )) {
      for (const layout of WRITE_SCALING_LAYOUTS) {
        for (const batchSize of MUTATION_BATCH_SIZES) {
          for (const strategy of [
            "individual",
            "batch",
          ]) {
            const raw = new CountingStore();
            const store = new EnvelopeObjectStore(
              raw,
              {
                key,
                keyId:
                  "mutation-batching-local-v1",
                compression: "gzip",
              },
            );
            const engine =
              layout === "snapshot"
                ? new ImmutableSnapshotEngine(
                    store,
                    40,
                    undefined,
                    false,
                    indexes,
                  )
                : new ContentAddressedTrieEngine(
                    store,
                    40,
                    undefined,
                    false,
                    indexes,
                  );
            await engine.putMany(
              "notes",
              documents,
            );
            raw.reset();
            const samples = [];
            for (
              let iteration = 0;
              iteration < iterations;
              iteration += 1
            ) {
              const changed = mutations(
                documents,
                batchSize,
                iteration,
              );
              const started = performance.now();
              if (strategy === "batch") {
                await engine.putMany(
                  "notes",
                  changed,
                );
              } else {
                for (const document of changed) {
                  await engine.put(
                    "notes",
                    document.id,
                    document,
                  );
                }
              }
              samples.push({
                elapsedMs: round(
                  performance.now() - started,
                ),
                reads: raw.reads,
                readBytes: raw.readBytes,
                writes: raw.writes,
                writeBytes: raw.writeBytes,
              });
              raw.reset();
            }
            results[
              [
                profile,
                indexSet,
                layout,
                `batch-${batchSize}`,
                strategy,
              ].join("-")
            ] = {
              profile,
              documents: count,
              indexSet,
              indexCount:
                indexes.notes?.length ?? 0,
              layout,
              batchSize,
              strategy,
              summary: summarise(
                samples,
                batchSize,
              ),
              samples,
            };
          }
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
    warning:
      "Local in-memory CPU preflight. Regional evidence remains authoritative for cloud latency.",
    results,
  };
  await mkdir("benchmark-results", {
    recursive: true,
  });
  const outputPath = path.resolve(
    "benchmark-results",
    `mutation-batching-${Date.now()}.json`,
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

function mutations(
  documents,
  batchSize,
  iteration,
) {
  return Array.from(
    { length: batchSize },
    (_, offset) => {
      const index =
        (
          iteration * 2_003 +
          offset * 997
        ) % documents.length;
      return {
        ...documents[index],
        body:
          `${documents[index].body} batch ` +
          `${batchSize} ${iteration}`,
        lastModified:
          documents.length +
          iteration * batchSize +
          offset,
      };
    },
  );
}

function comparisons(results) {
  const output = {};
  for (const value of Object.values(results)) {
    if (value.strategy !== "batch") {
      continue;
    }
    const baseline = results[
      [
        value.profile,
        value.indexSet,
        value.layout,
        `batch-${value.batchSize}`,
        "individual",
      ].join("-")
    ];
    output[
      [
        value.profile,
        value.indexSet,
        value.layout,
        `batch-${value.batchSize}`,
      ].join("-")
    ] = {
      totalP50ChangePercent: change(
        value.summary.p50Ms,
        baseline.summary.p50Ms,
      ),
      totalP95ChangePercent: change(
        value.summary.p95Ms,
        baseline.summary.p95Ms,
      ),
      perDocumentP50ChangePercent: change(
        value.summary.p50PerDocumentMs,
        baseline.summary.p50PerDocumentMs,
      ),
      readCountPerDocumentChangePercent:
        change(
          value.summary.meanReadsPerDocument,
          baseline.summary
            .meanReadsPerDocument,
        ),
      writeCountPerDocumentChangePercent:
        change(
          value.summary.meanWritesPerDocument,
          baseline.summary
            .meanWritesPerDocument,
        ),
      writeBytesPerDocumentChangePercent:
        change(
          value.summary.meanWriteBytesPerDocument,
          baseline.summary
            .meanWriteBytesPerDocument,
        ),
    };
  }
  return output;
}

function summarise(samples, batchSize) {
  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    meanMs: mean(elapsed),
    p50PerDocumentMs:
      round(
        percentile(elapsed, 0.5) /
          batchSize,
      ),
    p95PerDocumentMs:
      round(
        percentile(elapsed, 0.95) /
          batchSize,
      ),
    meanReadsPerDocument: mean(
      samples.map(
        (sample) =>
          sample.reads / batchSize,
      ),
    ),
    meanReadBytesPerDocument: Math.round(
      mean(
        samples.map(
          (sample) =>
            sample.readBytes / batchSize,
        ),
      ),
    ),
    meanWritesPerDocument: mean(
      samples.map(
        (sample) =>
          sample.writes / batchSize,
      ),
    ),
    meanWriteBytesPerDocument: Math.round(
      mean(
        samples.map(
          (sample) =>
            sample.writeBytes / batchSize,
        ),
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

class CountingStore {
  objects = new Map();
  etag = 0;
  reads = 0;
  readBytes = 0;
  writes = 0;
  writeBytes = 0;

  get(key) {
    const object = this.objects.get(key);
    this.reads += 1;
    this.readBytes +=
      object?.bytes.byteLength ?? 0;
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
      return Promise.reject(
        new PreconditionFailedError(key),
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
        .filter((key) =>
          key.startsWith(prefix),
        )
        .sort(),
    );
  }

  reset() {
    this.reads = 0;
    this.readBytes = 0;
    this.writes = 0;
    this.writeBytes = 0;
  }
}

await main();
