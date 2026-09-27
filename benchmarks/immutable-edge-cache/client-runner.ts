import {
  MemoryObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "../../src/browser/cache.js";
import { ThimbleClient } from "../../src/browser/client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  HttpPointReadBundleReader,
  ScopedJsonObjectReader,
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
type Operation =
  | "point"
  | "bundle"
  | "covered-equality"
  | "uncovered-equality"
  | "covered-range"
  | "scan";
type CacheState =
  | "baseline"
  | "edge-warm"
  | "edge-cold";
type ReadCase = {
  name: string;
  operation: Operation;
  layout: Layout;
  cacheState: CacheState;
};

const target = required("TARGET_URL").replace(/\/+$/, "");
const region = required("BENCHMARK_REGION");
const runId = required("BENCHMARK_RUN_ID");
const resultToken = required("BENCHMARK_RESULT_TOKEN");
let config: BenchmarkConfig;
let key: CryptoKey;
let colo = "unknown";
let cachedObjectProbe:
  | { url: string; namespace: string }
  | undefined;

async function main() {
  const security = await initialSecurityChecks();
  const configResponse = await fetch(
    `${target}/benchmark-config.json`,
    {
      cache: "no-store",
      headers: {
        "x-benchmark-token": resultToken,
      },
    },
  );
  if (!configResponse.ok) {
    throw new Error(
      `Benchmark configuration failed with ${configResponse.status}`,
    );
  }
  colo =
    configResponse.headers.get("x-benchmark-colo") ??
      "unknown";
  config =
    (await configResponse.json()) as BenchmarkConfig;
  const rawKey = base64ToBytes(config.keyBase64);
  key = await importAesGcmKey(
    rawKey,
    ["decrypt"],
  );
  rawKey.fill(0);

  const result = await runReadBenchmark();
  if (!cachedObjectProbe) {
    throw new Error(
      "No prewarmed cached object was observed",
    );
  }
  const cachedAuthorizationResponse = await fetch(
    cachedObjectProbe.url,
    {
      cache: "no-store",
      headers: {
        "x-benchmark-cache-namespace":
          cachedObjectProbe.namespace,
      },
    },
  );
  security.cachedObjectWithoutToken =
    cachedAuthorizationResponse.status;
  if (security.cachedObjectWithoutToken !== 403) {
    throw new Error(
      "A cached object was accessible without authorization",
    );
  }
  await storeResult({
    ...result,
    security,
  });
  console.log(JSON.stringify({
    stored: true,
    runId,
    region,
    colo,
    operations: countOperations(result.profiles),
    security,
  }, null, 2));
}

async function runReadBenchmark() {
  const pointIterations = integerValue(
    process.env.POINT_ITERATIONS,
    8,
    1,
    50,
  );
  const coldPointIterations = integerValue(
    process.env.COLD_POINT_ITERATIONS,
    2,
    1,
    10,
  );
  const queryIterations = integerValue(
    process.env.QUERY_ITERATIONS,
    4,
    1,
    20,
  );
  const coldQueryIterations = integerValue(
    process.env.COLD_QUERY_ITERATIONS,
    1,
    1,
    5,
  );
  const scanIterations = integerValue(
    process.env.SCAN_ITERATIONS,
    1,
    1,
    5,
  );
  const coldScanIterations = integerValue(
    process.env.COLD_SCAN_ITERATIONS,
    1,
    1,
    3,
  );
  const profiles: Record<string, unknown> = {};

  for (const [profile, profileConfig] of Object.entries(
    config.profiles,
  )) {
    const pointSteady = readCases(
      ["point", "bundle"],
      ["baseline", "edge-warm"],
    );
    const pointCold = readCases(
      ["point", "bundle"],
      ["edge-cold"],
    );
    const querySteady = readCases(
      [
        "covered-equality",
        "uncovered-equality",
        "covered-range",
      ],
      ["baseline", "edge-warm"],
    );
    const queryCold = readCases(
      [
        "covered-equality",
        "uncovered-equality",
        "covered-range",
      ],
      ["edge-cold"],
    );
    const scanSteady = readCases(
      ["scan"],
      ["baseline", "edge-warm"],
    );
    const scanCold = readCases(
      ["scan"],
      ["edge-cold"],
    );

    await warmCases(
      profile,
      pointSteady,
      profileConfig.pointIds[0]!,
    );
    await warmCases(profile, querySteady);
    await warmCases(profile, scanSteady);

    const pointSamples = sampleMap([
      ...pointSteady,
      ...pointCold,
    ]);
    for (
      let index = 0;
      index < pointIterations;
      index += 1
    ) {
      const id =
        profileConfig.pointIds[
          index % profileConfig.pointIds.length
        ]!;
      for (const definition of rotate(
        pointSteady,
        index,
      )) {
        pointSamples[definition.name]!.push(
          await measuredCase(
            profile,
            definition,
            id,
            index,
          ),
        );
      }
    }
    for (
      let index = 0;
      index < coldPointIterations;
      index += 1
    ) {
      const id =
        profileConfig.pointIds[
          (pointIterations + index) %
            profileConfig.pointIds.length
        ]!;
      for (const definition of rotate(
        pointCold,
        index,
      )) {
        pointSamples[definition.name]!.push(
          await measuredCase(
            profile,
            definition,
            id,
            index,
          ),
        );
      }
    }

    const querySamples = sampleMap([
      ...querySteady,
      ...queryCold,
    ]);
    for (
      let index = 0;
      index < queryIterations;
      index += 1
    ) {
      for (const definition of rotate(
        querySteady,
        index,
      )) {
        querySamples[definition.name]!.push(
          await measuredCase(
            profile,
            definition,
            undefined,
            index,
          ),
        );
      }
    }
    for (
      let index = 0;
      index < coldQueryIterations;
      index += 1
    ) {
      for (const definition of rotate(
        queryCold,
        index,
      )) {
        querySamples[definition.name]!.push(
          await measuredCase(
            profile,
            definition,
            undefined,
            index,
          ),
        );
      }
    }

    const scanSamples = sampleMap([
      ...scanSteady,
      ...scanCold,
    ]);
    for (
      let index = 0;
      index < scanIterations;
      index += 1
    ) {
      for (const definition of rotate(
        scanSteady,
        index,
      )) {
        scanSamples[definition.name]!.push(
          await measuredCase(
            profile,
            definition,
            undefined,
            index,
          ),
        );
      }
    }
    for (
      let index = 0;
      index < coldScanIterations;
      index += 1
    ) {
      for (const definition of rotate(
        scanCold,
        index,
      )) {
        scanSamples[definition.name]!.push(
          await measuredCase(
            profile,
            definition,
            undefined,
            index,
          ),
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

  return {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    runId,
    region,
    colo,
    runtime: `Node ${process.version}`,
    iterations: {
      point: pointIterations,
      coldPoint: coldPointIterations,
      query: queryIterations,
      coldQuery: coldQueryIterations,
      scan: scanIterations,
      coldScan: coldScanIterations,
    },
    profiles,
  };
}

async function warmCases(
  profile: string,
  definitions: ReadCase[],
  id?: string,
) {
  for (const definition of definitions) {
    if (definition.cacheState === "edge-warm") {
      await primeUntilWarm(
        profile,
        definition,
        id,
      );
    } else {
      await retryWarmup(
        profile,
        definition,
        id,
      );
    }
  }
}

async function retryWarmup(
  profile: string,
  definition: ReadCase,
  id?: string,
) {
  let lastError = "Unknown warm-up failure";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await executeReadCase(
      profile,
      definition,
      id,
      cacheNamespace(
        "warmup",
        profile,
        definition,
        attempt,
      ),
      false,
    );
    if (result.success) {
      return;
    }
    lastError = result.error;
    await delay(500 * (attempt + 1));
  }
  throw new Error(
    `Warm-up failed for ${definition.name}: ${lastError}`,
  );
}

async function measuredCase(
  profile: string,
  definition: ReadCase,
  id: string | undefined,
  index: number,
) {
  const namespace = cacheNamespace(
    definition.cacheState === "edge-cold"
      ? "cold"
      : "warm",
    profile,
    definition,
    index,
  );
  if (definition.cacheState === "edge-warm") {
    await primeUntilWarm(
      profile,
      definition,
      id,
      namespace,
    );
  }
  return executeReadCase(
    profile,
    definition,
    id,
    namespace,
    true,
  );
}

async function primeUntilWarm(
  profile: string,
  definition: ReadCase,
  id?: string,
  namespace = cacheNamespace(
    "warm",
    profile,
    definition,
    0,
  ),
) {
  let lastError = "Unknown edge-cache prime failure";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await executeReadCase(
      profile,
      definition,
      id,
      namespace,
      false,
    );
    if (!result.success) {
      lastError = result.error;
      await delay(500 * (attempt + 1));
      continue;
    }
    if (
      result.edgeCacheMisses === 0 &&
      result.edgeCacheHits > 0
    ) {
      return;
    }
    lastError =
      `hits=${result.edgeCacheHits}, misses=${result.edgeCacheMisses}`;
    await delay(250 * (attempt + 1));
  }
  throw new Error(
    `Edge cache did not warm for ${definition.name}: ${lastError}`,
  );
}

async function executeReadCase(
  profile: string,
  definition: ReadCase,
  id: string | undefined,
  namespace: string,
  enforceCacheState: boolean,
) {
  const runtime = createClient(
    profile,
    definition,
    namespace,
  );
  const profileConfig = config.profiles[profile]!;
  const started = performance.now();
  let documents = 0;
  let plan: string | null = null;
  let scannedDocuments = 0;

  try {
    if (
      definition.operation === "point" ||
      definition.operation === "bundle"
    ) {
      const document = await runtime.client.get(
        config.collection,
        id!,
      );
      if (!document || document.id !== id) {
        throw new Error(
          `${definition.name} returned the wrong document`,
        );
      }
      documents = 1;
      plan = "point";
      scannedDocuments = 1;
    } else if (definition.operation === "scan") {
      const result = await runtime.client.scan(
        config.collection,
      );
      if (result.length !== profileConfig.documents) {
        throw new Error(
          `${definition.name} returned ${result.length} documents`,
        );
      }
      documents = result.length;
      plan = "scan";
      scannedDocuments = result.length;
    } else {
      const query =
        definition.operation === "covered-range"
          ? {
              version: 1 as const,
              where: {
                and: [
                  {
                    field: "lastModified",
                    operator: "gte" as const,
                    value:
                      profileConfig.expected.rangeLower,
                  },
                  {
                    field: "lastModified",
                    operator: "lte" as const,
                    value:
                      profileConfig.expected.rangeUpper,
                  },
                ],
              },
              limit: 25,
              maxScanDocuments: profileConfig.documents,
            }
          : {
              version: 1 as const,
              where: {
                field: "category",
                operator: "eq" as const,
                value:
                  profileConfig.expected.rareCategory,
              },
              limit: 25,
              maxScanDocuments: Math.max(
                profileConfig.expected.rareMatches,
                25,
              ),
            };
      const result =
        definition.operation === "uncovered-equality"
          ? await runtime.client.queryDocuments(
              config.collection,
              query,
            )
          : await runtime.client.queryDocuments(
              config.collection,
              query,
              definition.operation === "covered-range"
                ? ["title", "category"]
                : ["title", "lastModified"],
            );
      const expectedDocuments =
        definition.operation === "covered-range"
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
          `${definition.name} returned ${result.documents.length} documents with ${result.plan} plan`,
        );
      }
      documents = result.documents.length;
      plan = result.plan;
      scannedDocuments = result.scannedDocuments;
    }

    if (enforceCacheState) {
      if (
        definition.cacheState === "edge-warm" &&
        (runtime.tracker.edgeCacheMisses !== 0 ||
          runtime.tracker.edgeCacheHits < 1)
      ) {
        throw new Error(
          "Prewarmed edge-cache case did not contain only immutable-object hits",
        );
      }
      if (
        definition.cacheState === "edge-cold" &&
        runtime.tracker.edgeCacheMisses < 1
      ) {
        throw new Error(
          "Forced edge-cache miss case did not miss",
        );
      }
      if (
        definition.cacheState === "baseline" &&
        (runtime.tracker.edgeCacheHits !== 0 ||
          runtime.tracker.edgeCacheMisses !== 0)
      ) {
        throw new Error(
          "Baseline case unexpectedly used the edge cache",
        );
      }
    }

    if (
      !cachedObjectProbe &&
      runtime.tracker.edgeHitUrl
    ) {
      cachedObjectProbe = {
        url: runtime.tracker.edgeHitUrl,
        namespace,
      };
    }
    const metrics = runtime.client.metrics();
    return {
      case: definition.name,
      profile,
      layout: definition.layout,
      operation: definition.operation,
      cacheState: definition.cacheState,
      success: true,
      requestedId: id ?? null,
      clientElapsedMs: round(
        performance.now() - started,
      ),
      documents,
      plan,
      scannedDocuments,
      networkReads: metrics.remoteReads,
      networkBytes: metrics.remoteBytes,
      storageReads: runtime.tracker.storageReads,
      storageBytes: runtime.tracker.storageBytes,
      edgeCacheHits: runtime.tracker.edgeCacheHits,
      edgeCacheHitBytes:
        runtime.tracker.edgeCacheHitBytes,
      edgeCacheMisses:
        runtime.tracker.edgeCacheMisses,
      edgeCacheBypasses:
        runtime.tracker.edgeCacheBypasses,
      browserCache: metrics.cache,
      bundleFallbacks: metrics.bundleFallbacks,
    };
  } catch (error) {
    const metrics = runtime.client.metrics();
    return {
      case: definition.name,
      profile,
      layout: definition.layout,
      operation: definition.operation,
      cacheState: definition.cacheState,
      success: false,
      requestedId: id ?? null,
      clientElapsedMs: round(
        performance.now() - started,
      ),
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      documents: 0,
      plan: null,
      scannedDocuments: 0,
      networkReads: metrics.remoteReads,
      networkBytes: metrics.remoteBytes,
      storageReads: runtime.tracker.storageReads,
      storageBytes: runtime.tracker.storageBytes,
      edgeCacheHits: runtime.tracker.edgeCacheHits,
      edgeCacheHitBytes:
        runtime.tracker.edgeCacheHitBytes,
      edgeCacheMisses:
        runtime.tracker.edgeCacheMisses,
      edgeCacheBypasses:
        runtime.tracker.edgeCacheBypasses,
      browserCache: metrics.cache,
      bundleFallbacks: metrics.bundleFallbacks,
    };
  } finally {
    runtime.client.close();
  }
}

function createClient(
  profile: string,
  definition: ReadCase,
  namespace: string,
) {
  const edge =
    definition.cacheState !== "baseline";
  const tracker = new TrackingFetch(
    resultToken,
    edge ? namespace : null,
  );
  const path = edge ? "edge" : "baseline";
  const dataBaseUrl =
    `${target}/${path}-data/read/${profile}/${definition.layout}`;
  const reader = new ScopedJsonObjectReader(
    new EnvelopeJsonObjectReader(
      new HttpByteObjectReader(
        dataBaseUrl,
        tracker.fetch,
        target,
      ),
      (keyId) => keyId === config.keyId ? key : null,
      config.decodedObjectLimit,
    ),
    config.scopeId,
  );
  const bundleReader =
    definition.operation === "bundle"
      ? new HttpPointReadBundleReader(
          `${target}/${path}-bundle/${profile}/${definition.layout}`,
          config.scopeId,
          tracker.fetch,
          target,
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
      [config.collection]:
        definition.layout as CollectionLayout,
    },
    collectionIndexes: config.indexes,
    layoutGeneration: "immutable-edge-cache-v1",
    configurationCheckedAt: Date.now(),
    layoutCheckTtlMs: Number.MAX_SAFE_INTEGER,
    channelName:
      `thimble-edge-${region}-${profile}-${definition.name}-${crypto.randomUUID()}`,
  });
  return { client, tracker };
}

class TrackingFetch {
  storageReads = 0;
  storageBytes = 0;
  edgeCacheHits = 0;
  edgeCacheHitBytes = 0;
  edgeCacheMisses = 0;
  edgeCacheBypasses = 0;
  edgeHitUrl: string | undefined;

  constructor(
    private readonly token: string,
    private readonly cacheNamespace: string | null,
  ) {}

  readonly fetch: typeof fetch = async (
    input,
    init = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set("x-benchmark-token", this.token);
    if (this.cacheNamespace) {
      headers.set(
        "x-benchmark-cache-namespace",
        this.cacheNamespace,
      );
    }
    const response = await fetch(input, {
      ...init,
      cache: "no-store",
      headers,
    });
    this.storageReads += headerNumber(
      response,
      "x-benchmark-storage-reads",
    );
    this.storageBytes += headerNumber(
      response,
      "x-benchmark-storage-bytes",
    );
    const hits = headerNumber(
      response,
      "x-benchmark-edge-cache-hits",
    );
    this.edgeCacheHits += hits;
    this.edgeCacheHitBytes += headerNumber(
      response,
      "x-benchmark-edge-cache-hit-bytes",
    );
    this.edgeCacheMisses += headerNumber(
      response,
      "x-benchmark-edge-cache-misses",
    );
    this.edgeCacheBypasses += headerNumber(
      response,
      "x-benchmark-edge-cache-bypasses",
    );
    if (
      hits > 0 &&
      !this.edgeHitUrl &&
      this.cacheNamespace
    ) {
      this.edgeHitUrl =
        input instanceof Request
          ? input.url
          : new URL(String(input), target).toString();
    }
    return response;
  };
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

async function initialSecurityChecks() {
  const configWithoutToken = await fetch(
    `${target}/benchmark-config.json`,
    { cache: "no-store" },
  );
  const dataWithoutToken = await fetch(
    `${target}/baseline-data/read/small/snapshot/scopes/benchmark/content-snapshot/notes/HEAD.json`,
    { cache: "no-store" },
  );
  if (
    configWithoutToken.status !== 403 ||
    dataWithoutToken.status !== 403
  ) {
    throw new Error(
      "Benchmark configuration or object data was accessible without authorization",
    );
  }
  return {
    configWithoutToken: configWithoutToken.status,
    objectWithoutToken: dataWithoutToken.status,
    cachedObjectWithoutToken: 0,
  };
}

async function storeResult(result: unknown) {
  const url = new URL("/regional-result", target);
  url.searchParams.set("run", runId);
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

function readCases(
  operations: Operation[],
  cacheStates: CacheState[],
): ReadCase[] {
  return operations.flatMap((operation) =>
    cacheStates.flatMap((cacheState) =>
      (["snapshot", "trie"] as const).map((layout) => ({
        name: `${operation}-${cacheState}-${layout}`,
        operation,
        layout,
        cacheState,
      })),
    ),
  );
}

function sampleMap(definitions: ReadCase[]) {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      [] as unknown[],
    ]),
  );
}

function cacheNamespace(
  mode: "warm" | "cold" | "warmup",
  profile: string,
  definition: ReadCase,
  index: number,
): string {
  const value = [
    mode,
    runId,
    region,
    profile,
    definition.operation,
    definition.layout,
    definition.cacheState,
    mode === "cold" ? index : 0,
  ].join("-").replace(/[^a-z0-9._/-]/gi, "-");
  return value.slice(0, 160);
}

function headerNumber(
  response: Response,
  name: string,
): number {
  const value = Number(response.headers.get(name) ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function countOperations(
  profiles: Record<string, unknown>,
): number {
  let total = 0;
  for (const profile of Object.values(profiles)) {
    const groups = profile as Record<
      string,
      Record<string, unknown[]>
    >;
    for (const name of ["point", "queries", "scans"]) {
      for (const samples of Object.values(
        groups[name] ?? {},
      )) {
        total += samples.length;
      }
    }
  }
  return total;
}

function rotate<T>(values: T[], index: number): T[] {
  const offset = index % values.length;
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
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

function delay(milliseconds: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

await main();
