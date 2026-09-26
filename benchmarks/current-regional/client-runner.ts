import {
  MemoryObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "../../src/browser/cache.js";
import { ThimbleClient } from "../../src/browser/client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  ScopedJsonObjectReader,
  type PointReadBundleReader,
  type RemoteReadBundle,
} from "../../src/browser/remote-reader.js";
import {
  base64ToBytes,
  importAesGcmKey,
} from "../../src/envelope.js";
import type {
  CollectionIndexConfiguration,
} from "../../src/secondary-index.js";
import type {
  CollectionLayout,
} from "../../src/snapshot-protocol.js";
import type { TrieReadBundle } from "../../src/trie-protocol.js";

type BenchmarkConfig = {
  sourceCommit: string;
  harnessCommit: string;
  keyBase64: string;
  keyId: string;
  scopeId: string;
  collection: string;
  decodedObjectLimit: number;
  indexes: CollectionIndexConfiguration;
  regions: string[];
  profiles: Record<
    string,
    {
      documents: number;
      pointIds: string[];
      expected: {
        rareCategory: string;
        rareMatches: number;
        rangeLower: number;
        rangeUpper: number;
        rangeMatches: number;
      };
    }
  >;
};

type Layout = "snapshot" | "trie";
type ReadOperation =
  | "point"
  | "bundle"
  | "covered-equality"
  | "uncovered-equality"
  | "covered-range"
  | "scan";

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
const key = await importAesGcmKey(
  rawKey,
  ["decrypt"],
);
rawKey.fill(0);

async function runReadBenchmark() {
  const pointIterations = integerValue(
    process.env.POINT_ITERATIONS,
    12,
    1,
    100,
  );
  const queryIterations = integerValue(
    process.env.QUERY_ITERATIONS,
    5,
    1,
    50,
  );
  const scanIterations = integerValue(
    process.env.SCAN_ITERATIONS,
    2,
    1,
    10,
  );
  const profiles: Record<string, unknown> = {};

  for (const [profile, profileConfig] of Object.entries(
    config.profiles,
  )) {
    const pointCases = [
      "point-snapshot",
      "point-trie",
      "bundle-snapshot",
      "bundle-trie",
    ];
    const queryCases = [
      "covered-equality-snapshot",
      "covered-equality-trie",
      "uncovered-equality-snapshot",
      "uncovered-equality-trie",
      "covered-range-snapshot",
      "covered-range-trie",
    ];
    const scanCases = ["scan-snapshot", "scan-trie"];

    for (const caseName of pointCases) {
      await runReadCase(
        profile,
        caseName,
        profileConfig.pointIds[0]!,
      );
    }
    for (const caseName of queryCases) {
      await runReadCase(profile, caseName);
    }
    for (const caseName of scanCases) {
      await runReadCase(profile, caseName);
    }

    const pointSamples = sampleMap(pointCases);
    for (let index = 0; index < pointIterations; index += 1) {
      const id =
        profileConfig.pointIds[
          index % profileConfig.pointIds.length
        ]!;
      for (const caseName of rotate(pointCases, index)) {
        pointSamples[caseName]!.push(
          await runReadCase(profile, caseName, id),
        );
      }
    }

    const querySamples = sampleMap(queryCases);
    for (let index = 0; index < queryIterations; index += 1) {
      for (const caseName of rotate(queryCases, index)) {
        querySamples[caseName]!.push(
          await runReadCase(profile, caseName),
        );
      }
    }

    const scanSamples = sampleMap(scanCases);
    for (let index = 0; index < scanIterations; index += 1) {
      for (const caseName of rotate(scanCases, index)) {
        scanSamples[caseName]!.push(
          await runReadCase(profile, caseName),
        );
      }
    }

    profiles[profile] = {
      documents: profileConfig.documents,
      point: pointSamples,
      queries: querySamples,
      scans: scanSamples,
    };
  }

  const limitResponse = await fetch(`${target}/limit-check`, {
    cache: "no-store",
  });
  const limitCheck = await limitResponse.json();
  if (!limitResponse.ok) {
    throw new Error(
      `Decoded-limit check failed with ${limitResponse.status}`,
    );
  }
  return {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    mode,
    runId,
    region,
    colo,
    runtime: `Node ${process.version}`,
    iterations: {
      point: pointIterations,
      query: queryIterations,
      scan: scanIterations,
    },
    decodedObjectLimit: config.decodedObjectLimit,
    limitCheck,
    profiles,
  };
}

async function runWriteBenchmark() {
  const iterations = integerValue(
    process.env.WRITE_ITERATIONS,
    8,
    1,
    30,
  );
  const samples = sampleMap(["write-snapshot", "write-trie"]);
  for (let index = 0; index < iterations; index += 1) {
    for (const caseName of rotate(
      ["write-snapshot", "write-trie"],
      index,
    )) {
      const layout = caseName.endsWith("snapshot")
        ? "snapshot"
        : "trie";
      samples[caseName]!.push(
        await invokeWrite(
          layout,
          "single",
          index,
          runId,
        ),
      );
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    mode,
    runId,
    region,
    colo,
    runtime: `Node ${process.version}`,
    iterations,
    samples,
  };
}

async function runContentionBenchmark() {
  const iterations = integerValue(
    process.env.CONTENTION_ITERATIONS,
    5,
    1,
    20,
  );
  const replicate = required("BENCHMARK_REPLICATE");
  const startAt = Number(required("CONTENTION_START_AT_MS"));
  if (!Number.isFinite(startAt) || startAt <= Date.now()) {
    throw new Error("CONTENTION_START_AT_MS must be in the future");
  }
  const samples = sampleMap([
    "contention-snapshot",
    "contention-trie",
  ]);
  await waitUntil(startAt);
  for (let index = 0; index < iterations; index += 1) {
    const [snapshot, trie] = await Promise.all([
      invokeWrite(
        "snapshot",
        "contention",
        index,
        replicate,
        true,
      ),
      invokeWrite(
        "trie",
        "contention",
        index,
        replicate,
        true,
      ),
    ]);
    samples["contention-snapshot"]!.push(snapshot);
    samples["contention-trie"]!.push(trie);
  }
  return {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    mode,
    runId,
    replicate,
    region,
    colo,
    runtime: `Node ${process.version}`,
    iterations,
    scheduledStartAt: new Date(startAt).toISOString(),
    samples,
  };
}

async function runReadCase(
  profile: string,
  caseName: string,
  id?: string,
) {
  const layout: Layout = caseName.endsWith("snapshot")
    ? "snapshot"
    : "trie";
  const operation = caseName.slice(
    0,
    caseName.length - layout.length - 1,
  ) as ReadOperation;
  const bundle = operation === "bundle";
  const runtime = createClient(profile, layout, bundle);
  const profileConfig = config.profiles[profile]!;
  const started = performance.now();
  let documents = 0;
  let plan: string | null = null;
  let scannedDocuments = 0;

  try {
    if (operation === "point" || operation === "bundle") {
      const document = await runtime.client.get(
        config.collection,
        id!,
      );
      if (!document || document.id !== id) {
        throw new Error(`${caseName} returned the wrong document`);
      }
      documents = 1;
      plan = "point";
      scannedDocuments = 1;
    } else if (operation === "scan") {
      const result = await runtime.client.scan(
        config.collection,
      );
      if (result.length !== profileConfig.documents) {
        throw new Error(
          `${caseName} returned ${result.length} documents`,
        );
      }
      documents = result.length;
      plan = "scan";
      scannedDocuments = result.length;
    } else {
      const query =
        operation === "covered-range"
          ? {
              version: 1 as const,
              where: {
                and: [
                  {
                    field: "lastModified",
                    operator: "gte" as const,
                    value: profileConfig.expected.rangeLower,
                  },
                  {
                    field: "lastModified",
                    operator: "lte" as const,
                    value: profileConfig.expected.rangeUpper,
                  },
                ],
              },
              limit: 25,
              maxScanDocuments: Math.max(
                profileConfig.expected.rangeMatches,
                25,
              ),
            }
          : {
              version: 1 as const,
              where: {
                field: "category",
                operator: "eq" as const,
                value: profileConfig.expected.rareCategory,
              },
              limit: 25,
              maxScanDocuments: Math.max(
                profileConfig.expected.rareMatches,
                25,
              ),
            };
      const result =
        operation === "uncovered-equality"
          ? await runtime.client.queryDocuments(
              config.collection,
              query,
            )
          : await runtime.client.queryDocuments(
              config.collection,
              query,
              operation === "covered-range"
                ? ["title", "category"]
                : ["title", "lastModified"],
            );
      const expectedDocuments =
        operation === "covered-range"
          ? profileConfig.expected.rangeMatches
          : Math.min(
              25,
              profileConfig.expected.rareMatches,
            );
      if (
        result.documents.length !== expectedDocuments ||
        result.plan !== "index"
      ) {
        throw new Error(
          `${caseName} returned ${result.documents.length} documents with ${result.plan} plan`,
        );
      }
      documents = result.documents.length;
      plan = result.plan;
      scannedDocuments = result.scannedDocuments;
    }
    const clientElapsedMs = round(
      performance.now() - started,
    );
    const metrics = runtime.client.metrics();
    return {
      case: caseName,
      profile,
      layout,
      operation,
      requestedId: id ?? null,
      clientElapsedMs,
      documents,
      plan,
      scannedDocuments,
      networkReads:
        metrics.remoteReads + metrics.bundleReads,
      networkBytes:
        metrics.remoteBytes + metrics.bundleBytes,
      objectReads:
        bundle
          ? runtime.bundleReader?.lastStorageReads ?? 0
          : metrics.remoteReads,
      objectBytes:
        bundle
          ? runtime.bundleReader?.lastStorageBytes ?? 0
          : metrics.remoteBytes,
      cache: metrics.cache,
      bundleFallbacks: metrics.bundleFallbacks,
    };
  } finally {
    runtime.client.close();
  }
}

function createClient(
  profile: string,
  layout: Layout,
  bundle: boolean,
) {
  const dataBaseUrl =
    `${target}/data/${profile}/${layout}`;
  const reader = new ScopedJsonObjectReader(
    new EnvelopeJsonObjectReader(
      new HttpByteObjectReader(
        dataBaseUrl,
        fetch,
        target,
      ),
      (keyId) => keyId === config.keyId ? key : null,
      config.decodedObjectLimit,
    ),
    config.scopeId,
  );
  const bundleReader = bundle
    ? new TrackedBundleReader(
        `${target}/bundle/${profile}/${layout}`,
        config.scopeId,
      )
    : undefined;
  const cache = new TieredObjectCache(
    new MemoryObjectCache(),
    new NullPersistentObjectCache(),
    "content",
  );
  const client = new ThimbleClient({
    reader,
    ...(bundleReader ? { bundleReader } : {}),
    cache,
    headTtlMs: 60_000,
    scopeId: config.scopeId,
    scopeKeyId: config.keyId,
    collectionLayouts: {
      [config.collection]: layout as CollectionLayout,
    },
    collectionIndexes: config.indexes,
    layoutGeneration: "current-regional-v1",
    configurationCheckedAt: Date.now(),
    layoutCheckTtlMs: Number.MAX_SAFE_INTEGER,
    channelName:
      `thimble-benchmark-${region}-${profile}-${layout}-${crypto.randomUUID()}`,
  });
  return { client, bundleReader };
}

class TrackedBundleReader implements PointReadBundleReader {
  lastStorageReads = 0;
  lastStorageBytes = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly scopeId: string,
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<RemoteReadBundle> {
    const url = [
      this.baseUrl.replace(/\/+$/, ""),
      encodeURIComponent(this.scopeId),
      encodeURIComponent(collection),
      encodeURIComponent(id),
    ].join("/");
    const response = await fetch(url, {
      cache: "no-store",
    });
    if (
      response.status === 404 ||
      response.status === 409 ||
      response.status === 413
    ) {
      return { status: "fallback" };
    }
    if (!response.ok) {
      throw new Error(
        `Bundle request failed with ${response.status}`,
      );
    }
    this.lastStorageReads = Number(
      response.headers.get("x-benchmark-storage-reads") ??
        "0",
    );
    this.lastStorageBytes = Number(
      response.headers.get("x-benchmark-storage-bytes") ??
        "0",
    );
    const body = await response.text();
    return {
      status: "found",
      bundle: JSON.parse(body) as TrieReadBundle,
      bytes: new TextEncoder().encode(body).byteLength,
    };
  }
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
  layout: Layout,
  writeMode: "single" | "contention",
  iteration: number,
  replicate: string,
  tolerateFailure = false,
) {
  const url = new URL("/write", target);
  url.searchParams.set("layout", layout);
  url.searchParams.set("mode", writeMode);
  url.searchParams.set("region", region);
  url.searchParams.set("replicate", replicate);
  url.searchParams.set("iteration", String(iteration));
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-benchmark-token": resultToken,
    },
  });
  const clientElapsedMs = round(
    performance.now() - started,
  );
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok && !tolerateFailure) {
    throw new Error(
      `${layout} write returned ${response.status}: ${body.error}`,
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
