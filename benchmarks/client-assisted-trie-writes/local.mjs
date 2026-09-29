import {
  createHash,
  createHmac,
} from "node:crypto";
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
import { EnvelopeObjectStore } from "../../src/envelope-store.ts";
import {
  applyClientAssistedTrieWrite,
} from "../../src/experimental/client-write-context.ts";
import {
  importAesGcmKey,
} from "../../src/envelope.ts";
import { captureClientTrieWriteContext } from "./context.ts";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_PROFILES,
  WRITE_SCALING_INDEX_SETS,
  benchmarkDocuments,
} from "../write-scaling/regional/scenario.ts";

const iterations = Number(
  process.env.THIMBLE_CLIENT_WRITE_ITERATIONS ?? "6",
);
const scopeId = "user:client-write-local";
const layoutGeneration = "client-write-v1";
const modes = [
  "baseline",
  "tree-context",
  "full-context",
];

async function main() {
  const rawKey = Uint8Array.from(
    { length: 32 },
    (_, index) => index + 67,
  );
  const key = await importAesGcmKey(
    rawKey,
    ["encrypt", "decrypt"],
  );
  const addressKey = Buffer.from(
    "client-write-address-key-v1",
  );
  const signatureKey = Buffer.from(
    "client-write-signature-key-v1",
  );
  const addressNode = (bytes) =>
    createHmac("sha256", addressKey)
      .update(bytes)
      .digest("hex");
  const sign = (bytes) =>
    createHmac("sha256", signatureKey)
      .update(bytes)
      .digest("hex");
  const results = {};

  for (const [profile, count] of Object.entries(
    BENCHMARK_PROFILES,
  )) {
    const documents = benchmarkDocuments(count);
    for (const [indexSet, indexes] of Object.entries(
      WRITE_SCALING_INDEX_SETS,
    )) {
      const seededRaw = new CountingStore();
      const seededStore = envelope(seededRaw, key);
      await engine(
        seededStore,
        indexes,
        addressNode,
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
            `${documents[index].body} client-write ` +
            iteration,
          lastModified: count + iteration,
        };
        const stores = Object.fromEntries(
          modes.map((mode) => {
            const raw = seededRaw.clone();
            return [
              mode,
              {
                raw,
                store: envelope(raw, key),
              },
            ];
          }),
        );
        const tree = await captureClientTrieWriteContext({
          store: stores["tree-context"].store,
          addressNode,
          sign,
          scopeId,
          collection: BENCHMARK_COLLECTION,
          documentId: document.id,
          layoutGeneration,
          indexConfiguration: indexes,
          includeIndexes: false,
        });
        const full = await captureClientTrieWriteContext({
          store: stores["full-context"].store,
          addressNode,
          sign,
          scopeId,
          collection: BENCHMARK_COLLECTION,
          documentId: document.id,
          layoutGeneration,
          indexConfiguration: indexes,
          includeIndexes: true,
        });
        const contexts = {
          "tree-context": roundTrip(tree.context),
          "full-context": roundTrip(full.context),
        };

        for (const mode of modes) {
          const runtime = stores[mode];
          runtime.raw.resetMetrics();
          const started = performance.now();
          let result = null;
          if (mode === "baseline") {
            await engine(
              runtime.store,
              indexes,
              addressNode,
            ).put(
              BENCHMARK_COLLECTION,
              document.id,
              document,
            );
          } else {
            result =
              await applyClientAssistedTrieWrite({
                store: runtime.store,
                addressNode,
                verifySignature: sign,
                scopeId,
                collection: BENCHMARK_COLLECTION,
                layoutGeneration,
                document,
                context: contexts[mode],
                indexConfiguration: indexes,
              });
          }
          samples[mode].push({
            elapsedMs: round(
              performance.now() - started,
            ),
            reads: runtime.raw.reads,
            readBytes: runtime.raw.readBytes,
            writes: runtime.raw.writes,
            writeBytes: runtime.raw.writeBytes,
            preconditionFailures:
              runtime.raw.preconditionFailures,
            requestBytes:
              mode === "tree-context"
                ? tree.requestBytes
                : mode === "full-context"
                  ? full.requestBytes
                  : 0,
            verificationMs:
              result?.verificationMs ?? 0,
            contextHits:
              result?.contextHits ?? 0,
            authoritativeReadsDuringAttempt:
              result?.authoritativeReadsDuringAttempt ??
              runtime.raw.reads,
            mode: result?.mode ?? "baseline",
            fallbackReason:
              result?.fallbackReason ?? null,
          });
        }

        const baselineSnapshot =
          await decodedSnapshot(
            stores.baseline.store,
          );
        for (const mode of [
          "tree-context",
          "full-context",
        ]) {
          const candidateSnapshot =
            await decodedSnapshot(
              stores[mode].store,
            );
          if (
            JSON.stringify(candidateSnapshot) !==
            JSON.stringify(baselineSnapshot)
          ) {
            throw new Error(
              `${profile}/${indexSet}/${mode} changed protocol objects`,
            );
          }
        }
      }

      const caseName = `${profile}-${indexSet}`;
      results[caseName] = {
        profile,
        documents: count,
        indexSet,
        indexCount:
          indexes.notes?.length ?? 0,
        modes: Object.fromEntries(
          modes.map((mode) => [
            mode,
            {
              summary: summarise(samples[mode]),
              samples: samples[mode],
            },
          ]),
        ),
        comparisons: {
          treeContext:
            comparison(
              samples.baseline,
              samples["tree-context"],
            ),
          fullContext:
            comparison(
              samples.baseline,
              samples["full-context"],
            ),
        },
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
      correctness:
        "Decoded keys and values must match baseline for every case.",
      fullContextReads:
        "Full context must perform zero authoritative reads during the assisted attempt.",
      indexedP50:
        "Medium and large indexed full-context p50 should improve by at least 25%.",
      requestBytes:
        "Large two-index context must remain at or below 4 MiB.",
    },
    results,
  };
  await mkdir("benchmark-results", {
    recursive: true,
  });
  const outputPath = path.resolve(
    "benchmark-results",
    `client-assisted-trie-writes-${Date.now()}.json`,
  );
  await writeFile(
    outputPath,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        outputPath,
        results: Object.fromEntries(
          Object.entries(results).map(
            ([name, result]) => [
              name,
              {
                baseline:
                  result.modes.baseline.summary,
                treeContext:
                  result.modes["tree-context"]
                    .summary,
                fullContext:
                  result.modes["full-context"]
                    .summary,
                comparisons: result.comparisons,
              },
            ],
          ),
        ),
      },
      null,
      2,
    ),
  );
}

function engine(
  store,
  indexes,
  addressNode,
) {
  return new ContentAddressedTrieEngine(
    store,
    40,
    addressNode,
    false,
    indexes,
  );
}

function envelope(raw, key) {
  return new EnvelopeObjectStore(raw, {
    key,
    keyId: "client-write-local-v1",
    compression: "gzip",
  });
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

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarise(samples) {
  return {
    p50Ms: percentile(
      samples.map((sample) => sample.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      samples.map((sample) => sample.elapsedMs),
      0.95,
    ),
    meanMs: mean(
      samples.map((sample) => sample.elapsedMs),
    ),
    meanReads: mean(
      samples.map((sample) => sample.reads),
    ),
    meanReadBytes: Math.round(
      mean(
        samples.map((sample) => sample.readBytes),
      ),
    ),
    meanWrites: mean(
      samples.map((sample) => sample.writes),
    ),
    meanWriteBytes: Math.round(
      mean(
        samples.map((sample) => sample.writeBytes),
      ),
    ),
    meanRequestBytes: Math.round(
      mean(
        samples.map((sample) => sample.requestBytes),
      ),
    ),
    meanVerificationMs: mean(
      samples.map(
        (sample) => sample.verificationMs,
      ),
    ),
    meanContextHits: mean(
      samples.map((sample) => sample.contextHits),
    ),
    fallbacks: samples.filter(
      (sample) => sample.mode === "fallback",
    ).length,
  };
}

function comparison(baseline, candidate) {
  const baselineSummary = summarise(baseline);
  const candidateSummary = summarise(candidate);
  return {
    p50ChangePercent: percentChange(
      baselineSummary.p50Ms,
      candidateSummary.p50Ms,
    ),
    p95ChangePercent: percentChange(
      baselineSummary.p95Ms,
      candidateSummary.p95Ms,
    ),
    readChangePercent: percentChange(
      baselineSummary.meanReads,
      candidateSummary.meanReads,
    ),
    readByteChangePercent: percentChange(
      baselineSummary.meanReadBytes,
      candidateSummary.meanReadBytes,
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

function percentChange(baseline, candidate) {
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
  readBytes = 0;
  writes = 0;
  writeBytes = 0;
  preconditionFailures = 0;

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
    this.readBytes = 0;
    this.writes = 0;
    this.writeBytes = 0;
    this.preconditionFailures = 0;
  }
}

await main();
