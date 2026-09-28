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
import { stableStringify } from "../../src/shared-utils.ts";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_PROFILES,
  MUTATION_BATCH_ACCEPTANCE,
  MUTATION_BATCH_INDEX_SETS,
  MUTATION_BATCH_LAYOUTS,
  MUTATION_BATCH_SIZES,
  MUTATION_BATCH_STRATEGIES,
  benchmarkDocuments,
  mutationDocuments,
} from "./regional/scenario.ts";

const iterations = integerValue(
  process.env.THIMBLE_MUTATION_BATCH_ITERATIONS,
  2,
  1,
  10,
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
      MUTATION_BATCH_INDEX_SETS,
    )) {
      for (const layout of MUTATION_BATCH_LAYOUTS) {
        for (const batchSize of MUTATION_BATCH_SIZES) {
          for (const strategy of MUTATION_BATCH_STRATEGIES) {
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
              BENCHMARK_COLLECTION,
              documents,
            );
            raw.reset();
            const samples = [];
            let expectedRevision = 1;

            for (
              let iteration = 0;
              iteration < iterations;
              iteration += 1
            ) {
              const changed = mutationDocuments(
                count,
                batchSize,
                iteration,
              );
              const started = performance.now();
              if (strategy === "batch") {
                await engine.putMany(
                  BENCHMARK_COLLECTION,
                  changed,
                );
                expectedRevision += 1;
              } else {
                for (const document of changed) {
                  await engine.put(
                    BENCHMARK_COLLECTION,
                    document.id,
                    document,
                  );
                }
                expectedRevision += batchSize;
              }
              const elapsedMs = round(
                performance.now() - started,
              );
              const metrics = raw.snapshot();
              const verification = await verify(
                engine,
                changed,
                expectedRevision,
              );
              samples.push({
                elapsedMs,
                documents: batchSize,
                storage: metrics,
                diagnostics: engine.diagnostics(),
                ...verification,
              });
              raw.reset();
            }

            results[
              caseName(
                profile,
                indexSet,
                layout,
                batchSize,
                strategy,
              )
            ] = {
              profile,
              documents: count,
              indexSet,
              indexCount:
                indexes[BENCHMARK_COLLECTION]
                  ?.length ?? 0,
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

  const comparisons = buildComparisons(results);
  const output = {
    generatedAt: new Date().toISOString(),
    sourceCommit:
      process.env.THIMBLE_BENCHMARK_SOURCE_COMMIT ??
        null,
    iterations,
    acceptance: MUTATION_BATCH_ACCEPTANCE,
    warning:
      "Local in-memory CPU preflight. Regional evidence remains authoritative for cloud latency.",
    results,
    comparisons,
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
    comparisons,
  }, null, 2));
}

async function verify(
  engine,
  documents,
  expectedRevision,
) {
  const loaded = await Promise.all(
    documents.map((document) =>
      engine.get(
        BENCHMARK_COLLECTION,
        document.id,
      ),
    ),
  );
  const mismatches = documents.filter(
    (document, index) =>
      stableStringify(loaded[index]) !==
        stableStringify(document),
  );
  const bundle = await engine.readBundle(
    BENCHMARK_COLLECTION,
    documents[0].id,
  );
  if (
    mismatches.length > 0 ||
    bundle.revision !== expectedRevision
  ) {
    throw new Error(
      `Mutation verification failed at revision ${bundle.revision}; expected ${expectedRevision}`,
    );
  }
  return {
    verificationPassed: true,
    revision: bundle.revision,
    verifiedDocuments: documents.length,
  };
}

function buildComparisons(results) {
  const output = {};
  for (const value of Object.values(results)) {
    if (value.strategy !== "batch") {
      continue;
    }
    const baseline = results[
      caseName(
        value.profile,
        value.indexSet,
        value.layout,
        value.batchSize,
        "individual",
      )
    ];
    const comparison = {
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
      batchMeanHeadWrites:
        value.summary.meanHeadWrites,
      individualMeanHeadWrites:
        baseline.summary.meanHeadWrites,
      verificationPassed:
        value.summary.verificationFailures === 0 &&
        baseline.summary.verificationFailures === 0,
    };
    comparison.accepted =
      value.batchSize === 1
        ? comparison.verificationPassed &&
          value.summary.meanHeadWrites === 1
        : comparison.verificationPassed &&
          value.summary.meanHeadWrites === 1 &&
          comparison.perDocumentP50ChangePercent <=
            MUTATION_BATCH_ACCEPTANCE[
              value.batchSize
            ];
    output[
      [
        value.profile,
        value.indexSet,
        value.layout,
        `batch-${value.batchSize}`,
      ].join("-")
    ] = comparison;
  }
  return output;
}

function summarise(samples, batchSize) {
  const elapsed = sorted(
    samples.map((sample) => sample.elapsedMs),
  );
  return {
    operations: samples.length,
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    meanMs: mean(elapsed),
    p50PerDocumentMs:
      round(percentile(elapsed, 0.5) / batchSize),
    p95PerDocumentMs:
      round(percentile(elapsed, 0.95) / batchSize),
    meanReads: mean(
      samples.map(
        (sample) =>
          sample.storage.reads.count,
      ),
    ),
    meanReadsPerDocument: mean(
      samples.map(
        (sample) =>
          sample.storage.reads.count /
          batchSize,
      ),
    ),
    meanReadBytesPerDocument: Math.round(
      mean(
        samples.map(
          (sample) =>
            sample.storage.reads.bytes /
            batchSize,
        ),
      ),
    ),
    meanWrites: mean(
      samples.map(
        (sample) =>
          sample.storage.writes.count,
      ),
    ),
    meanWritesPerDocument: mean(
      samples.map(
        (sample) =>
          sample.storage.writes.count /
          batchSize,
      ),
    ),
    meanWriteBytesPerDocument: Math.round(
      mean(
        samples.map(
          (sample) =>
            sample.storage.writes.bytes /
            batchSize,
        ),
      ),
    ),
    meanHeadWrites: mean(
      samples.map(
        (sample) =>
          sample.storage.byKind.head
            ?.writes.count ?? 0,
      ),
    ),
    meanIndexWrites: mean(
      samples.map(
        (sample) =>
          sample.storage.byKind.index
            ?.writes.count ?? 0,
      ),
    ),
    meanCasRetries: mean(
      samples.map(
        (sample) =>
          sample.diagnostics.casRetries ?? 0,
      ),
    ),
    verificationFailures:
      samples.filter(
        (sample) =>
          sample.verificationPassed !== true,
      ).length,
  };
}

function caseName(
  profile,
  indexSet,
  layout,
  batchSize,
  strategy,
) {
  return [
    profile,
    indexSet,
    layout,
    `batch-${batchSize}`,
    strategy,
  ].join("-");
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

function sorted(values) {
  return [...values].sort(
    (left, right) => left - right,
  );
}

function round(value) {
  return Number(value.toFixed(3));
}

function integerValue(
  value,
  fallback,
  minimum,
  maximum,
) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `Iterations must be ${minimum}-${maximum}`,
    );
  }
  return parsed;
}

class CountingStore {
  objects = new Map();
  etag = 0;
  metrics = createMetrics();

  get(key) {
    const object = this.objects.get(key);
    record(
      this.metrics,
      "reads",
      key,
      object?.bytes.byteLength ?? 0,
    );
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
      this.metrics.preconditionFailures += 1;
      return Promise.reject(
        new PreconditionFailedError(key),
      );
    }
    const etag = String(++this.etag);
    this.objects.set(key, {
      bytes: bytes.slice(),
      etag,
    });
    record(
      this.metrics,
      "writes",
      key,
      bytes.byteLength,
    );
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

  snapshot() {
    return structuredClone(this.metrics);
  }

  reset() {
    this.metrics = createMetrics();
  }
}

function createMetrics() {
  return {
    reads: metric(),
    writes: metric(),
    preconditionFailures: 0,
    byKind: {},
  };
}

function metric() {
  return {
    count: 0,
    bytes: 0,
  };
}

function record(
  metrics,
  operation,
  key,
  bytes,
) {
  metrics[operation].count += 1;
  metrics[operation].bytes += bytes;
  const kind = objectKind(key);
  metrics.byKind[kind] ??= {
    reads: metric(),
    writes: metric(),
  };
  metrics.byKind[kind][operation].count += 1;
  metrics.byKind[kind][operation].bytes +=
    bytes;
}

function objectKind(key) {
  if (key.endsWith("/HEAD.json")) {
    return "head";
  }
  if (key.includes("/indexes/")) {
    return "index";
  }
  if (key.includes("/snapshots/")) {
    return "snapshot";
  }
  if (key.includes("/nodes/")) {
    return "trie-node";
  }
  return "other";
}

await main();
