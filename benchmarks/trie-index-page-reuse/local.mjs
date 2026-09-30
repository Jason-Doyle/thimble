import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  PreconditionFailedError,
} from "../../src/core.ts";
import { ContentAddressedTrieEngine } from "../../src/engines/content-trie.ts";
import { EnvelopeObjectStore } from "../../src/envelope-store.ts";
import {
  importAesGcmKey,
} from "../../src/envelope.ts";
import { DuplicateIndexReadStore } from "./control.ts";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_PROFILES,
  WRITE_SCALING_INDEX_SETS,
  benchmarkDocuments,
} from "../write-scaling/regional/scenario.ts";

const iterations = Number(
  process.env.THIMBLE_INDEX_REUSE_ITERATIONS ?? "8",
);
const modes = ["duplicate", "reuse"];

async function main() {
  const rawKey = Uint8Array.from(
    { length: 32 },
    (_, index) => index + 193,
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
      const seededRaw = new CountingStore();
      await engine(
        envelope(seededRaw, key),
        indexes,
      ).putMany(BENCHMARK_COLLECTION, documents);
      const samples = Object.fromEntries(
        modes.map((mode) => [mode, []]),
      );

      for (
        let iteration = 0;
        iteration < iterations;
        iteration += 1
      ) {
        const index =
          (iteration * 997) % count;
        const document = {
          ...documents[index],
          body:
            `${documents[index].body} index-reuse ` +
            iteration,
          lastModified: count + iteration,
        };
        const duplicateRaw = seededRaw.clone();
        const reuseRaw = seededRaw.clone();
        const duplicateStore = new DuplicateIndexReadStore(
          envelope(duplicateRaw, key),
        );
        const reuseStore = envelope(reuseRaw, key);
        duplicateRaw.resetMetrics();
        reuseRaw.resetMetrics();

        const duplicateStarted = performance.now();
        await engine(
          duplicateStore,
          indexes,
        ).put(
          BENCHMARK_COLLECTION,
          document.id,
          document,
        );
        samples.duplicate.push(
          sample(
            performance.now() -
              duplicateStarted,
            duplicateRaw,
          ),
        );

        const reuseStarted = performance.now();
        await engine(
          reuseStore,
          indexes,
        ).put(
          BENCHMARK_COLLECTION,
          document.id,
          document,
        );
        samples.reuse.push(
          sample(
            performance.now() - reuseStarted,
            reuseRaw,
          ),
        );

        const duplicateSnapshot =
          await decodedSnapshot(
            duplicateStore,
          );
        const reuseSnapshot =
          await decodedSnapshot(reuseStore);
        if (
          JSON.stringify(duplicateSnapshot) !==
          JSON.stringify(reuseSnapshot)
        ) {
          throw new Error(
            `${profile}/${indexSet} changed protocol objects`,
          );
        }
      }

      results[`${profile}-${indexSet}`] = {
        profile,
        documents: count,
        indexSet,
        indexCount:
          indexes.notes?.length ?? 0,
        duplicate: {
          summary: summarise(
            samples.duplicate,
          ),
          samples: samples.duplicate,
        },
        reuse: {
          summary: summarise(samples.reuse),
          samples: samples.reuse,
        },
        comparison: compare(
          samples.reuse,
          samples.duplicate,
        ),
      };
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sourceCommit:
      process.env.THIMBLE_BENCHMARK_SOURCE_COMMIT ??
        null,
    iterations,
    warning:
      "Local in-memory CPU and operation-count preflight. Regional cloud evidence remains required for end-to-end latency conclusions.",
    acceptance: {
      protocolEquivalent:
        "Every candidate must retain identical decoded keys and bytes.",
      reads:
        "Reuse must remove exactly one read per configured index.",
      indexedP50:
        "Indexed candidate p50 must not regress by more than 5%.",
    },
    results,
  };
  await mkdir("benchmark-results", {
    recursive: true,
  });
  const outputPath = path.resolve(
    "benchmark-results",
    `trie-index-page-reuse-${Date.now()}.json`,
  );
  await writeFile(
    outputPath,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(JSON.stringify({
    outputPath,
    results: Object.fromEntries(
      Object.entries(results).map(
        ([name, result]) => [
          name,
          {
            duplicate:
              result.duplicate.summary,
            reuse: result.reuse.summary,
            comparison: result.comparison,
          },
        ],
      ),
    ),
  }, null, 2));
}

function engine(store, indexes) {
  return new ContentAddressedTrieEngine(
    store,
    40,
    undefined,
    false,
    indexes,
  );
}

function envelope(raw, key) {
  return new EnvelopeObjectStore(raw, {
    key,
    keyId: "trie-index-reuse-local-v1",
    compression: "gzip",
  });
}

function sample(elapsedMs, raw) {
  return {
    elapsedMs: round(elapsedMs),
    reads: raw.reads,
    indexReads: raw.indexReads,
    readBytes: raw.readBytes,
    writes: raw.writes,
    writeBytes: raw.writeBytes,
    preconditionFailures:
      raw.preconditionFailures,
  };
}

async function decodedSnapshot(store) {
  const keys = (await store.list("")).sort();
  return Promise.all(
    keys.map(async (key) => {
      const object = await store.get(key);
      return [
        key,
        object
          ? Buffer.from(object.bytes).toString("base64")
          : null,
      ];
    }),
  );
}

function summarise(samples) {
  return {
    p50Ms: percentile(
      samples.map((value) => value.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      samples.map((value) => value.elapsedMs),
      0.95,
    ),
    meanMs: mean(
      samples.map((value) => value.elapsedMs),
    ),
    meanReads: mean(
      samples.map((value) => value.reads),
    ),
    meanIndexReads: mean(
      samples.map((value) => value.indexReads),
    ),
    meanReadBytes: Math.round(
      mean(
        samples.map((value) => value.readBytes),
      ),
    ),
    meanWrites: mean(
      samples.map((value) => value.writes),
    ),
    meanWriteBytes: Math.round(
      mean(
        samples.map((value) => value.writeBytes),
      ),
    ),
  };
}

function compare(candidate, baseline) {
  const candidateSummary =
    summarise(candidate);
  const baselineSummary =
    summarise(baseline);
  return {
    p50ChangePercent: change(
      candidateSummary.p50Ms,
      baselineSummary.p50Ms,
    ),
    p95ChangePercent: change(
      candidateSummary.p95Ms,
      baselineSummary.p95Ms,
    ),
    readCountChangePercent: change(
      candidateSummary.meanReads,
      baselineSummary.meanReads,
    ),
    readByteChangePercent: change(
      candidateSummary.meanReadBytes,
      baselineSummary.meanReadBytes,
    ),
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort(
    (left, right) => left - right,
  );
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.ceil(sorted.length * quantile) - 1,
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

function change(candidate, baseline) {
  if (baseline === 0) {
    return candidate === 0 ? 0 : null;
  }
  return Number(
    (
      ((candidate - baseline) / baseline) *
      100
    ).toFixed(2),
  );
}

function round(value) {
  return Number(value.toFixed(3));
}

class CountingStore {
  objects = new Map();
  etag = 0;
  reads = 0;
  indexReads = 0;
  readBytes = 0;
  writes = 0;
  writeBytes = 0;
  preconditionFailures = 0;

  get(key) {
    const object = this.objects.get(key);
    this.reads += 1;
    if (key.includes("/indexes/")) {
      this.indexReads += 1;
    }
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
      this.preconditionFailures += 1;
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
      [...this.objects.keys()].filter((key) =>
        key.startsWith(prefix),
      ),
    );
  }

  clone() {
    const clone = new CountingStore();
    clone.etag = this.etag;
    clone.objects = new Map(
      [...this.objects].map(([key, object]) => [
        key,
        {
          bytes: object.bytes.slice(),
          etag: object.etag,
        },
      ]),
    );
    return clone;
  }

  resetMetrics() {
    this.reads = 0;
    this.indexReads = 0;
    this.readBytes = 0;
    this.writes = 0;
    this.writeBytes = 0;
    this.preconditionFailures = 0;
  }
}

await main();
