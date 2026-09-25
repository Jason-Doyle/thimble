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
  buildIndexedSegment,
} from "../../src/experimental/indexed-segment.ts";
import {
  ExperimentalManifestedSegmentEngine,
} from "../../src/experimental/manifested-segment.ts";

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
    if (conditions.ifNoneMatch && current) {
      return Promise.reject(
        new PreconditionFailedError("exists"),
      );
    }
    if (
      conditions.ifMatch !== undefined &&
      current?.etag !== conditions.ifMatch
    ) {
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
  }
}

const documents = Number(
  process.env.THIMBLE_WRITE_DOCUMENTS ?? "50000",
);
const iterations = Number(
  process.env.THIMBLE_WRITE_ITERATIONS ?? "12",
);
if (
  !Number.isInteger(documents) ||
  documents < 1_000 ||
  documents > 100_000 ||
  !Number.isInteger(iterations) ||
  iterations < 3 ||
  iterations > 50
) {
  throw new Error("Invalid write benchmark configuration");
}

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 41,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const fingerprintKey = await crypto.subtle.importKey(
  "raw",
  rawKey,
  {
    name: "HMAC",
    hash: "SHA-256",
  },
  false,
  ["sign"],
);
const fields = [
  { field: "category", mode: "equality" },
  { field: "bucket", mode: "equality" },
  { field: "lastModified", mode: "range" },
];
const initial = notes(documents);

const snapshotStore = new CountingStore();
const snapshot = new ImmutableSnapshotEngine(
  encrypted(snapshotStore),
);
await snapshot.putMany("notes", initial);
snapshotStore.reset();

const trieStore = new CountingStore();
const trie = new ContentAddressedTrieEngine(
  encrypted(trieStore),
);
await trie.putMany("notes", initial);
trieStore.reset();

const manifestedStore = new CountingStore();
const manifested = new ExperimentalManifestedSegmentEngine(
  encrypted(manifestedStore),
  {
    targetBlockBytes: 256 * 1024,
    collectionFields: { notes: fields },
  },
);
await manifested.putMany("notes", initial);
manifestedStore.reset();

let tisDocuments = initial;
await buildIndexedSegment(tisDocuments, {
  targetBlockBytes: 64 * 1024,
  fields,
  security: {
    key,
    keyId: "write-benchmark-v1",
    fingerprintKey,
    context: "write-benchmark/notes",
  },
});

const results = {
  snapshot: [],
  trie: [],
  manifested: [],
  tis1: [],
};
for (let index = 0; index < iterations; index += 1) {
  const documentIndex =
    (Math.floor(documents / 2) + index * 997) % documents;
  const id = initial[documentIndex].id;
  const replacement = {
    ...initial[documentIndex],
    body: `updated ${index} ${"y".repeat(80)}`,
    lastModified: documents + index,
  };

  results.snapshot.push(
    await engineWrite(
      snapshot,
      snapshotStore,
      id,
      replacement,
    ),
  );
  results.trie.push(
    await engineWrite(
      trie,
      trieStore,
      id,
      replacement,
    ),
  );
  results.manifested.push(
    await engineWrite(
      manifested,
      manifestedStore,
      id,
      replacement,
    ),
  );

  tisDocuments = tisDocuments.map((document) =>
    document.id === id ? replacement : document,
  );
  const started = performance.now();
  const segment = await buildIndexedSegment(tisDocuments, {
    targetBlockBytes: 64 * 1024,
    fields,
    security: {
      key,
      keyId: "write-benchmark-v1",
      fingerprintKey,
      context: "write-benchmark/notes",
    },
  });
  results.tis1.push({
    elapsedMs: round(performance.now() - started),
    reads: 0,
    readBytes: 0,
    writes: 1,
    writeBytes: segment.byteLength,
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  documents,
  iterations,
  warning:
    "Local in-memory object-store evidence. It includes current codecs, encryption, compression, reads, immutable writes, and HEAD CAS, but excludes cloud network latency.",
  summary: Object.fromEntries(
    Object.entries(results).map(([name, samples]) => [
      name,
      summarise(samples),
    ]),
  ),
  samples: results,
};
await mkdir("benchmark-results", { recursive: true });
const outputPath = path.resolve(
  "benchmark-results",
  `manifested-write-${Date.now()}.json`,
);
await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
console.log(`Raw result: ${outputPath}`);

async function engineWrite(
  engine,
  store,
  id,
  document,
) {
  store.reset();
  const started = performance.now();
  await engine.put("notes", id, document);
  return {
    elapsedMs: round(performance.now() - started),
    reads: store.reads,
    readBytes: store.readBytes,
    writes: store.writes,
    writeBytes: store.writeBytes,
  };
}

function encrypted(store) {
  return new EnvelopeObjectStore(store, {
    key,
    keyId: "write-benchmark-v1",
    compression: "gzip",
  });
}

function notes(count) {
  const rare = Math.floor(count * 0.05);
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${String(index).padStart(6, "0")}`,
    title: `Note ${index % 50}`,
    category: index < rare ? "rare" : "common",
    bucket: `bucket-${String(index % 20).padStart(2, "0")}`,
    body: `body ${index} ${"x".repeat(120)}`,
    lastModified: index,
    active: index % 5 !== 0,
  }));
}

function summarise(samples) {
  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    meanMs: round(mean(elapsed)),
    meanReads: round(mean(samples.map((sample) => sample.reads))),
    meanReadBytes: Math.round(
      mean(samples.map((sample) => sample.readBytes)),
    ),
    meanWrites: round(
      mean(samples.map((sample) => sample.writes)),
    ),
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
  return (
    values.reduce((total, value) => total + value, 0) /
    values.length
  );
}

function round(value) {
  return Number(value.toFixed(3));
}
