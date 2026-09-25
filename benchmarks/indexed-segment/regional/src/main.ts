import {
  MemoryObjectCache,
  TieredObjectCache,
} from "../../../../src/browser/cache.js";
import { ThimbleClient } from "../../../../src/browser/client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  HttpPointReadBundleReader,
  objectUrl,
} from "../../../../src/browser/remote-reader.js";
import type {
  JsonDocument,
  JsonValue,
} from "../../../../src/core.js";
import {
  base64ToBytes,
  decodeEnvelope,
  importAesGcmKey,
} from "../../../../src/envelope.js";
import {
  HttpIndexedSegmentSource,
  IndexedSegmentReader,
  type IndexedSegmentPredicate,
} from "../../../../src/experimental/indexed-segment.js";
import {
  decodeJson,
  ownValue,
} from "../../../../src/shared-utils.js";
import type {
  SnapshotHead,
  SnapshotPage,
} from "../../../../src/snapshot-protocol.js";
import {
  snapshotHeadKey,
  snapshotPageKey,
} from "../../../../src/snapshot-protocol.js";

type Config = {
  documents: number;
  keyBase64: string;
  keyId: string;
  context: string;
  pointIds: string[];
  clusteredCategory: string;
  distributedBucket: string;
  rangeLower: number;
  rangeUpper: number;
};

type OperationResult = {
  elapsedMs: number;
  requests: number;
  bytes: number;
  documents: number;
};

type BenchmarkOptions = {
  region: string;
  pointIterations?: number;
  queryIterations?: number;
  scanIterations?: number;
};

declare global {
  interface Window {
    runRegionalBenchmark(
      options: BenchmarkOptions,
    ): Promise<unknown>;
    benchmarkReady: boolean;
  }
}

const encoder = new TextEncoder();
const config = await loadConfig();
const rawKey = base64ToBytes(config.keyBase64);
const encryptionKey = await importAesGcmKey(
  rawKey,
  ["decrypt"],
);
const fingerprintRaw = new Uint8Array(
  new ArrayBuffer(rawKey.byteLength),
);
fingerprintRaw.set(rawKey);
const fingerprintKey = await crypto.subtle.importKey(
  "raw",
  fingerprintRaw,
  {
    name: "HMAC",
    hash: "SHA-256",
  },
  false,
  ["sign"],
);

window.runRegionalBenchmark = runRegionalBenchmark;
window.benchmarkReady = true;
document.querySelector("#status")!.textContent =
  `Ready with ${config.documents.toLocaleString()} documents.`;

async function runRegionalBenchmark(
  options: BenchmarkOptions,
): Promise<unknown> {
  const pointIterations = options.pointIterations ?? 24;
  const queryIterations = options.queryIterations ?? 8;
  const scanIterations = options.scanIterations ?? 4;
  const pointFormats = [
    "experimental",
    "snapshot",
    "trie",
    "bundle",
  ] as const;

  for (const format of pointFormats) {
    await coldPoint(format, config.pointIds[0]!);
  }
  const coldPointSamples: Record<
    (typeof pointFormats)[number],
    OperationResult[]
  > = {
    experimental: [],
    snapshot: [],
    trie: [],
    bundle: [],
  };
  for (let index = 0; index < pointIterations; index += 1) {
    const id = config.pointIds[index % config.pointIds.length]!;
    for (const format of rotate(pointFormats, index)) {
      coldPointSamples[format].push(
        await coldPoint(format, id),
      );
    }
  }

  const connectedPoints = {
    experimental: await connectedExperimentalPoints(
      config.pointIds,
    ),
    snapshot: await connectedOldPoints(
      "snapshot",
      false,
      config.pointIds,
    ),
    trie: await connectedOldPoints(
      "trie",
      false,
      config.pointIds,
    ),
    bundle: await connectedOldPoints(
      "trie",
      true,
      config.pointIds,
    ),
  };

  const queries = {
    clusteredEquality: await compareQuery(
      {
        field: "category",
        operator: "eq",
        value: config.clusteredCategory,
      },
      queryIterations,
    ),
    narrowRange: await compareQuery(
      {
        field: "lastModified",
        operator: "between",
        lower: config.rangeLower,
        upper: config.rangeUpper,
      },
      queryIterations,
    ),
    distributedEquality: await compareQuery(
      {
        field: "bucket",
        operator: "eq",
        value: config.distributedBucket,
      },
      queryIterations,
    ),
    fullScan: await compareScan(scanIterations),
  };

  return {
    generatedAt: new Date().toISOString(),
    region: options.region,
    browser: navigator.userAgent,
    target: location.origin,
    documents: config.documents,
    iterations: {
      coldPoint: pointIterations,
      query: queryIterations,
      fullScan: scanIterations,
      connectedPoints: config.pointIds.length,
    },
    coldPoint: summariseFormats(coldPointSamples),
    coldPointSamples,
    connectedPoints,
    queries,
  };
}

async function coldPoint(
  format: "experimental" | "snapshot" | "trie" | "bundle",
  id: string,
): Promise<OperationResult> {
  if (format === "experimental") {
    const started = performance.now();
    const source = await HttpIndexedSegmentSource.open(
      "/data/experimental/notes.tis",
      { directoryPrefetchBytes: 64 * 1024 },
    );
    const reader = await IndexedSegmentReader.open(source, {
      cacheBlocks: false,
      security: {
        resolveKey: resolveKey,
        fingerprintKey,
        context: config.context,
      },
    });
    const document = await reader.get(id);
    requireDocument(document, id, format);
    return {
      elapsedMs: round(performance.now() - started),
      requests: source.reads,
      bytes: source.bytesRead,
      documents: 1,
    };
  }

  const client = createOldClient(
    format === "snapshot" ? "snapshot" : "trie",
    format === "bundle",
  );
  try {
    const started = performance.now();
    const document = await client.collection("notes").get(id);
    requireDocument(document, id, format);
    const metrics = client.metrics();
    return {
      elapsedMs: round(performance.now() - started),
      requests:
        metrics.remoteReads + metrics.bundleReads,
      bytes: metrics.remoteBytes + metrics.bundleBytes,
      documents: 1,
    };
  } finally {
    client.close();
  }
}

async function connectedExperimentalPoints(
  ids: string[],
): Promise<OperationResult> {
  const started = performance.now();
  const source = await HttpIndexedSegmentSource.open(
    "/data/experimental/notes.tis",
    { directoryPrefetchBytes: 64 * 1024 },
  );
  const reader = await IndexedSegmentReader.open(source, {
    cacheBlocks: true,
    security: {
      resolveKey,
      fingerprintKey,
      context: config.context,
    },
  });
  for (const id of ids) {
    requireDocument(
      await reader.get(id),
      id,
      "experimental-connected",
    );
  }
  return {
    elapsedMs: round(performance.now() - started),
    requests: source.reads,
    bytes: source.bytesRead,
    documents: ids.length,
  };
}

async function connectedOldPoints(
  layout: "snapshot" | "trie",
  bundle: boolean,
  ids: string[],
): Promise<OperationResult> {
  const client = createOldClient(layout, bundle);
  try {
    const started = performance.now();
    for (const id of ids) {
      requireDocument(
        await client.collection("notes").get(id),
        id,
        `${layout}-connected`,
      );
    }
    const metrics = client.metrics();
    return {
      elapsedMs: round(performance.now() - started),
      requests:
        metrics.remoteReads + metrics.bundleReads,
      bytes: metrics.remoteBytes + metrics.bundleBytes,
      documents: ids.length,
    };
  } finally {
    client.close();
  }
}

async function compareQuery(
  predicate: IndexedSegmentPredicate,
  iterations: number,
): Promise<unknown> {
  await Promise.all([
    experimentalQuery(predicate),
    snapshotQuery(predicate),
  ]);
  const samples = {
    experimental: [] as OperationResult[],
    snapshot: [] as OperationResult[],
  };
  for (let index = 0; index < iterations; index += 1) {
    const order =
      index % 2 === 0
        ? ["experimental", "snapshot"] as const
        : ["snapshot", "experimental"] as const;
    for (const format of order) {
      samples[format].push(
        format === "experimental"
          ? await experimentalQuery(predicate)
          : await snapshotQuery(predicate),
      );
    }
  }
  return {
    summary: summariseFormats(samples),
    samples,
  };
}

async function compareScan(iterations: number): Promise<unknown> {
  await Promise.all([
    experimentalScan(),
    snapshotScan(),
  ]);
  const samples = {
    experimental: [] as OperationResult[],
    snapshot: [] as OperationResult[],
  };
  for (let index = 0; index < iterations; index += 1) {
    const order =
      index % 2 === 0
        ? ["experimental", "snapshot"] as const
        : ["snapshot", "experimental"] as const;
    for (const format of order) {
      samples[format].push(
        format === "experimental"
          ? await experimentalScan()
          : await snapshotScan(),
      );
    }
  }
  return {
    summary: summariseFormats(samples),
    samples,
  };
}

async function experimentalQuery(
  predicate: IndexedSegmentPredicate,
): Promise<OperationResult> {
  const started = performance.now();
  const source = await HttpIndexedSegmentSource.open(
    "/data/experimental/notes.tis",
    { directoryPrefetchBytes: 64 * 1024 },
  );
  const reader = await IndexedSegmentReader.open(source, {
    cacheBlocks: false,
    security: {
      resolveKey,
      fingerprintKey,
      context: config.context,
    },
  });
  const result = await reader.query(predicate);
  return {
    elapsedMs: round(performance.now() - started),
    requests: source.reads,
    bytes: source.bytesRead,
    documents: result.documents.length,
  };
}

async function experimentalScan(): Promise<OperationResult> {
  const started = performance.now();
  const source = await HttpIndexedSegmentSource.open(
    "/data/experimental/notes.tis",
    { directoryPrefetchBytes: 64 * 1024 },
  );
  const reader = await IndexedSegmentReader.open(source, {
    cacheBlocks: false,
    security: {
      resolveKey,
      fingerprintKey,
      context: config.context,
    },
  });
  const documents = await reader.scan();
  if (documents.length !== config.documents) {
    throw new Error(
      `Experimental scan returned ${documents.length}`,
    );
  }
  return {
    elapsedMs: round(performance.now() - started),
    requests: source.reads,
    bytes: source.bytesRead,
    documents: documents.length,
  };
}

async function snapshotQuery(
  predicate: IndexedSegmentPredicate,
): Promise<OperationResult> {
  const loaded = await loadSnapshot();
  const documents = Object.values(loaded.page.documents).filter(
    (document): document is JsonDocument =>
      documentMatches(document as JsonDocument, predicate),
  );
  return {
    elapsedMs: loaded.elapsedMs,
    requests: loaded.requests,
    bytes: loaded.bytes,
    documents: documents.length,
  };
}

async function snapshotScan(): Promise<OperationResult> {
  const loaded = await loadSnapshot();
  const documents = Object.values(loaded.page.documents);
  if (documents.length !== config.documents) {
    throw new Error(
      `Snapshot scan returned ${documents.length}`,
    );
  }
  return {
    elapsedMs: loaded.elapsedMs,
    requests: loaded.requests,
    bytes: loaded.bytes,
    documents: documents.length,
  };
}

async function loadSnapshot(): Promise<{
  page: SnapshotPage;
  elapsedMs: number;
  requests: number;
  bytes: number;
}> {
  const started = performance.now();
  const head = await oldObject<SnapshotHead>(
    "snapshot",
    snapshotHeadKey("notes"),
  );
  if (!head.value.snapshotHash) {
    throw new Error("Snapshot HEAD has no page");
  }
  const page = await oldObject<SnapshotPage>(
    "snapshot",
    snapshotPageKey("notes", head.value.snapshotHash),
  );
  return {
    page: page.value,
    elapsedMs: round(performance.now() - started),
    requests: 2,
    bytes: head.bytes + page.bytes,
  };
}

async function oldObject<T>(
  layout: "snapshot" | "trie",
  key: string,
): Promise<{ value: T; bytes: number }> {
  const response = await fetch(
    objectUrl(`/data/${layout}`, key, location.href),
    {
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(
      `${layout} object ${key} returned ${response.status}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const plaintext = await decodeEnvelope(
    bytes,
    resolveKey,
    encoder.encode(key),
  );
  return {
    value: decodeJson<T>(plaintext),
    bytes: bytes.byteLength,
  };
}

function createOldClient(
  layout: "snapshot" | "trie",
  bundle: boolean,
): ThimbleClient {
  return new ThimbleClient({
    reader: new EnvelopeJsonObjectReader(
      new HttpByteObjectReader(`/data/${layout}`),
      resolveKey,
    ),
    ...(bundle
      ? {
          bundleReader: new HttpPointReadBundleReader(
            "/bundle",
            "benchmark",
          ),
        }
      : {}),
    cache: new TieredObjectCache(
      new MemoryObjectCache(),
      new NullPersistentCache(),
      "content",
    ),
    headTtlMs: 60_000,
    channelName: `regional-${crypto.randomUUID()}`,
    collectionLayouts: {
      notes: layout,
    },
  });
}

function documentMatches(
  document: JsonDocument,
  predicate: IndexedSegmentPredicate,
): boolean {
  const value = ownValue(
    document as Record<string, JsonValue>,
    predicate.field,
  );
  if (predicate.operator === "eq") {
    return value === predicate.value;
  }
  return (
    typeof value === typeof predicate.lower &&
    (typeof value === "string" || typeof value === "number") &&
    value >= predicate.lower &&
    value <= predicate.upper
  );
}

function summariseFormats(
  values: Record<string, OperationResult[]>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([name, samples]) => [
      name,
      summarise(samples),
    ]),
  );
}

function summarise(samples: OperationResult[]): unknown {
  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    operations: samples.length,
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    maxMs: elapsed.at(-1) ?? 0,
    meanMs: round(
      elapsed.reduce((total, value) => total + value, 0) /
        elapsed.length,
    ),
    meanRequests: round(
      samples.reduce(
        (total, sample) => total + sample.requests,
        0,
      ) / samples.length,
    ),
    meanBytes: Math.round(
      samples.reduce(
        (total, sample) => total + sample.bytes,
        0,
      ) / samples.length,
    ),
    documents: samples[0]?.documents ?? 0,
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  return values[
    Math.min(
      values.length - 1,
      Math.ceil(values.length * quantile) - 1,
    )
  ]!;
}

function rotate<T>(
  values: readonly T[],
  index: number,
): T[] {
  const offset = index % values.length;
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
}

function requireDocument(
  document: JsonDocument | null,
  id: string,
  format: string,
): void {
  if (!document || document.id !== id) {
    throw new Error(`${format} missed ${id}`);
  }
}

function resolveKey(keyId: string): CryptoKey | null {
  return keyId === config.keyId ? encryptionKey : null;
}

async function loadConfig(): Promise<Config> {
  const response = await fetch("/benchmark-config.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Benchmark config returned ${response.status}`,
    );
  }
  return response.json() as Promise<Config>;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

class NullPersistentCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  clear(): Promise<void> {
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export {};
