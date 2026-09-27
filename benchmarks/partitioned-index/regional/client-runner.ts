import {
  MemoryObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "../../../src/browser/cache.js";
import { ThimbleClient } from "../../../src/browser/client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  ScopedJsonObjectReader,
} from "../../../src/browser/remote-reader.js";
import {
  base64ToBytes,
  importAesGcmKey,
} from "../../../src/envelope.js";
import type {
  CollectionIndexConfiguration,
} from "../../../src/secondary-index.js";
import type {
  CollectionLayout,
} from "../../../src/snapshot-protocol.js";
import {
  snapshotHeadKey,
  snapshotIndexKey,
} from "../../../src/snapshot-protocol.js";
import {
  trieHeadKey,
  trieIndexKey,
} from "../../../src/trie-protocol.js";
import {
  experimentalIndexPartition,
  experimentalPartitionedIndexReferenceFromJson,
} from "../../../src/experimental/partitioned-secondary-index.js";
import type { JsonValue } from "../../../src/core.js";

type BenchmarkConfig = {
  sourceCommit: string;
  harnessCommit: string;
  keyBase64: string;
  keyId: string;
  scopeId: string;
  collection: string;
  documents: number;
  partitionCount: number;
  indexes: CollectionIndexConfiguration;
  variants: Array<"baseline" | "value-routed">;
  regions: string[];
  pointIds: string[];
  expected: {
    rareCategory: string;
    rareMatches: number;
    rangeLower: number;
    rangeUpper: number;
    rangeMatches: number;
  };
};

type Variant = "baseline" | "value-routed";
type Layout = "snapshot" | "trie";
type BenchmarkNote = {
  id: string;
  title: string;
  category: string;
  lastModified: number;
};
type QueryOperation =
  | "covered-equality"
  | "uncovered-equality"
  | "covered-range"
  | "warm-requery";

const target = required("TARGET_URL").replace(/\/+$/, "");
const region = required("BENCHMARK_REGION");
const runId = required("BENCHMARK_RUN_ID");
const mode = process.env.BENCHMARK_MODE ?? "read";
const resultToken = required("BENCHMARK_RESULT_TOKEN");
const configResponse = await fetch(
  `${target}/benchmark-config.json`,
  { cache: "no-store" },
);
if (!configResponse.ok) {
  throw new Error(
    `Benchmark configuration failed with ${configResponse.status}`,
  );
}
const colo =
  configResponse.headers.get("x-benchmark-colo") ?? "unknown";
const config = (await configResponse.json()) as BenchmarkConfig;
const rawKey = base64ToBytes(config.keyBase64);
const key = await importAesGcmKey(rawKey, ["decrypt"]);
rawKey.fill(0);

let result: unknown;
if (mode === "read") {
  result = await runReadBenchmark();
} else if (mode === "write") {
  result = await runWriteBenchmark();
} else if (mode === "contention") {
  result = await runContentionBenchmark();
} else {
  throw new Error(`Unknown benchmark mode ${mode}`);
}
await storeResult(result);
console.log(`THIMBLE_RESULT=${JSON.stringify(result)}`);

async function runReadBenchmark() {
  const iterations = integerValue(
    process.env.QUERY_ITERATIONS,
    5,
    1,
    30,
  );
  const cases = queryCases();
  for (const caseName of cases) {
    await runQueryCase(caseName);
  }
  const samples = sampleMap(cases);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const caseName of rotate(cases, iteration)) {
      samples[caseName]!.push(
        await runQueryCase(caseName),
      );
    }
  }
  return baseResult({
    iterations,
    samples,
  });
}

async function runWriteBenchmark() {
  const iterations = integerValue(
    process.env.WRITE_ITERATIONS,
    8,
    1,
    30,
  );
  const cases = writeCases("write");
  const samples = sampleMap(cases);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const caseName of rotate(cases, iteration)) {
      const { variant, layout } = parseWriteCase(caseName);
      samples[caseName]!.push(
        await invokeWrite(
          variant,
          layout,
          "single",
          iteration,
          runId,
        ),
      );
    }
  }
  return baseResult({
    iterations,
    samples,
  });
}

async function runContentionBenchmark() {
  const iterations = integerValue(
    process.env.CONTENTION_ITERATIONS,
    3,
    1,
    10,
  );
  const replicate = required("BENCHMARK_REPLICATE");
  const startAt = Number(required("CONTENTION_START_AT_MS"));
  if (!Number.isFinite(startAt) || startAt <= Date.now()) {
    throw new Error("CONTENTION_START_AT_MS must be in the future");
  }
  const cases = writeCases("contention");
  const samples = sampleMap(cases);
  await waitUntil(startAt);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const results = await Promise.all(
      cases.map(async (caseName) => {
        const { variant, layout } = parseWriteCase(caseName);
        return [
          caseName,
          await invokeWrite(
            variant,
            layout,
            "contention",
            iteration,
            replicate,
            true,
          ),
        ] as const;
      }),
    );
    for (const [caseName, sample] of results) {
      samples[caseName]!.push(sample);
    }
  }
  return baseResult({
    replicate,
    iterations,
    scheduledStartAt: new Date(startAt).toISOString(),
    samples,
  });
}

async function runQueryCase(caseName: string) {
  const { operation, variant, layout } =
    parseQueryCase(caseName);
  const runtime = createClient(variant, layout);
  let started = performance.now();
  try {
    const query =
      operation === "covered-range"
        ? {
            version: 1 as const,
            where: {
              and: [
                {
                  field: "lastModified",
                  operator: "gte" as const,
                  value: config.expected.rangeLower,
                },
                {
                  field: "lastModified",
                  operator: "lte" as const,
                  value: config.expected.rangeUpper,
                },
              ],
            },
            limit: 25,
            maxScanDocuments: config.documents,
          }
        : {
            version: 1 as const,
            where: {
              field: "category",
              operator: "eq" as const,
              value: config.expected.rareCategory,
            },
            limit: 25,
            maxScanDocuments: config.expected.rareMatches,
          };
    const execute = () =>
      operation === "uncovered-equality"
        ? runtime.client.queryDocuments<BenchmarkNote>(
            config.collection,
            query,
          )
        : runtime.client.queryDocuments<BenchmarkNote>(
            config.collection,
            query,
            operation === "covered-range"
              ? ["title", "category"]
              : ["title", "lastModified"],
          );
    if (operation === "warm-requery") {
      await execute();
      await invalidateWarmIndex(
        runtime.cache,
        variant,
        layout,
      );
      runtime.client.resetMetrics();
    }
    started = performance.now();
    const result = await execute();
    if (
      result.plan !== "index" ||
      result.documents.length !== 25
    ) {
      throw new Error(
        `${caseName} returned ${result.documents.length} documents with ${result.plan} plan`,
      );
    }
    const metrics = runtime.client.metrics();
    return {
      case: caseName,
      operation,
      variant,
      layout,
      success: true,
      clientElapsedMs: round(
        performance.now() - started,
      ),
      documents: result.documents.length,
      scannedDocuments: result.scannedDocuments,
      networkReads: metrics.remoteReads,
      networkBytes: metrics.remoteBytes,
      cache: metrics.cache,
    };
  } catch (error) {
    const metrics = runtime.client.metrics();
    return {
      case: caseName,
      operation,
      variant,
      layout,
      success: false,
      clientElapsedMs: round(
        performance.now() - started,
      ),
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      documents: 0,
      scannedDocuments: 0,
      networkReads: metrics.remoteReads,
      networkBytes: metrics.remoteBytes,
      cache: metrics.cache,
    };
  } finally {
    runtime.client.close();
  }
}

function createClient(
  variant: Variant,
  layout: Layout,
): {
  client: ThimbleClient;
  cache: TieredObjectCache;
} {
  const dataBaseUrl =
    `${target}/data/read/${variant}/${layout}`;
  const reader = new ScopedJsonObjectReader(
    new EnvelopeJsonObjectReader(
      new HttpByteObjectReader(
        dataBaseUrl,
        fetch,
        target,
      ),
      (keyId) => keyId === config.keyId ? key : null,
    ),
    config.scopeId,
  );
  const cache = new TieredObjectCache(
    new MemoryObjectCache(),
    new NullPersistentObjectCache(),
    "content",
  );
  const client = new ThimbleClient({
    reader,
    cache,
    headTtlMs: 60_000,
    scopeId: config.scopeId,
    scopeKeyId: config.keyId,
    collectionLayouts: {
      [config.collection]: layout as CollectionLayout,
    },
    collectionIndexes: config.indexes,
    layoutGeneration: "value-routed-index-v1",
    configurationCheckedAt: Date.now(),
    layoutCheckTtlMs: Number.MAX_SAFE_INTEGER,
    channelName:
      `value-routed-index-${region}-${variant}-${layout}-${crypto.randomUUID()}`,
  });
  return { client, cache };
}

async function invalidateWarmIndex(
  cache: TieredObjectCache,
  variant: Variant,
  layout: Layout,
) {
  const headKey =
    layout === "snapshot"
      ? snapshotHeadKey(config.collection)
      : trieHeadKey(config.collection);
  const cached = await cache.get(headKey);
  if (
    !cached ||
    typeof cached.value !== "object" ||
    cached.value === null ||
    Array.isArray(cached.value) ||
    typeof cached.value.indexes !== "object" ||
    cached.value.indexes === null ||
    Array.isArray(cached.value.indexes)
  ) {
    throw new Error("Warm query did not cache a collection HEAD");
  }
  const rawReference =
    cached.value.indexes["by-category"];
  if (
    typeof rawReference !== "object" ||
    rawReference === null ||
    Array.isArray(rawReference) ||
    typeof rawReference.hash !== "string"
  ) {
    throw new Error("Warm query HEAD is missing the category index");
  }
  let hash = rawReference.hash;
  if (variant === "value-routed") {
    if (rawReference.experimentalPartitions === undefined) {
      throw new Error(
        "Warm value-routed query is missing shard metadata",
      );
    }
    const metadata =
      experimentalPartitionedIndexReferenceFromJson(
        rawReference.experimentalPartitions,
      );
    const partition = experimentalIndexPartition(
      metadata.definition,
      {
        id: "benchmark-route",
        category: config.expected.rareCategory,
      },
      metadata.routing,
    );
    const shard = metadata.shards.find(
      (candidate) =>
        candidate.partition === partition,
    );
    if (!shard) {
      throw new Error(
        "Warm value-routed query did not select a stored shard",
      );
    }
    hash = shard.hash;
  }
  const indexKey =
    layout === "snapshot"
      ? snapshotIndexKey(
          config.collection,
          "by-category",
          hash,
        )
      : trieIndexKey(
          config.collection,
          "by-category",
          hash,
        );
  await Promise.all([
    cache.delete(headKey),
    cache.delete(indexKey),
  ]);
}

class NullPersistentObjectCache
implements PersistentObjectCache {
  get() {
    return Promise.resolve(null);
  }
  set() {
    return Promise.resolve();
  }
  delete() {
    return Promise.resolve();
  }
  clear() {
    return Promise.resolve();
  }
  destroy() {
    return Promise.resolve();
  }
}

async function invokeWrite(
  variant: Variant,
  layout: Layout,
  writeMode: "single" | "contention",
  iteration: number,
  replicate: string,
  tolerateFailure = false,
) {
  const url = new URL("/write", target);
  url.searchParams.set("variant", variant);
  url.searchParams.set("layout", layout);
  url.searchParams.set("mode", writeMode);
  url.searchParams.set("region", region);
  url.searchParams.set("replicate", replicate);
  url.searchParams.set("iteration", String(iteration));
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-benchmark-token": resultToken,
      },
    });
  } catch (error) {
    if (!tolerateFailure) {
      throw error;
    }
    return {
      variant,
      layout,
      mode: writeMode,
      success: false,
      status: 0,
      clientElapsedMs: round(
        performance.now() - started,
      ),
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
  const clientElapsedMs = round(
    performance.now() - started,
  );
  const responseText = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    body = {
      error:
        `Non-JSON response ${response.status}: ` +
        responseText.slice(0, 200),
    };
  }
  if (!response.ok && !tolerateFailure) {
    throw new Error(
      `${variant}/${layout} write returned ${response.status}: ${body.error}`,
    );
  }
  return {
    ...body,
    success: response.ok,
    status: response.status,
    clientElapsedMs,
  };
}

async function storeResult(result: unknown) {
  const url = new URL("/regional-result", target);
  url.searchParams.set("run", runId);
  url.searchParams.set("mode", mode);
  url.searchParams.set("region", region);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-benchmark-token": resultToken,
    },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    throw new Error(
      `Result upload failed with ${response.status}: ${await response.text()}`,
    );
  }
}

function baseResult(value: Record<string, unknown>) {
  return {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    mode,
    runId,
    region,
    colo,
    runtime: `Node ${process.version}`,
    documents: config.documents,
    partitionCount: config.partitionCount,
    ...value,
  };
}

function queryCases(): string[] {
  return [
    "covered-equality",
    "uncovered-equality",
    "covered-range",
    "warm-requery",
  ].flatMap((operation) =>
    config.variants.flatMap((variant) =>
      ["snapshot", "trie"].map(
        (layout) => `${operation}-${variant}-${layout}`,
      ),
    ),
  );
}

function writeCases(prefix: string): string[] {
  return config.variants.flatMap((variant) =>
    ["snapshot", "trie"].map(
      (layout) => `${prefix}-${variant}-${layout}`,
    ),
  );
}

function parseQueryCase(caseName: string): {
  operation: QueryOperation;
  variant: Variant;
  layout: Layout;
} {
  const layout = caseName.endsWith("-snapshot")
    ? "snapshot"
    : "trie";
  const withoutLayout = caseName.slice(
    0,
    -(layout.length + 1),
  );
  const variant = withoutLayout.endsWith("-value-routed")
    ? "value-routed"
    : "baseline";
  const operation = withoutLayout.slice(
    0,
    -(variant.length + 1),
  ) as QueryOperation;
  return { operation, variant, layout };
}

function parseWriteCase(caseName: string): {
  variant: Variant;
  layout: Layout;
} {
  const layout = caseName.endsWith("-snapshot")
    ? "snapshot"
    : "trie";
  const withoutLayout = caseName.slice(
    0,
    -(layout.length + 1),
  );
  return {
    variant: withoutLayout.endsWith("-value-routed")
      ? "value-routed"
      : "baseline",
    layout,
  };
}

function sampleMap(names: string[]) {
  return Object.fromEntries(
    names.map((name) => [name, [] as unknown[]]),
  );
}

function rotate<T>(values: T[], index: number): T[] {
  const offset = index % values.length;
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
}

async function waitUntil(timestamp: number) {
  while (Date.now() < timestamp) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(1_000, timestamp - Date.now()),
      ),
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
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
      `Iteration count must be ${minimum}-${maximum}`,
    );
  }
  return parsed;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
