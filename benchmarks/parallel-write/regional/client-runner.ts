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
import type {
  ThimbleQuery,
} from "../../../src/query.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_REGIONS,
  PARALLEL_WRITE_LAYOUTS,
  PARALLEL_WRITE_VARIANTS,
  type ParallelWriteLayout,
  type ParallelWriteVariant,
} from "./scenario.js";

type Config = {
  sourceCommit: string;
  harnessCommit: string;
  keyBase64: string;
  keyId: string;
  scopeId: string;
  collection: string;
  documents: number;
  indexes: CollectionIndexConfiguration;
  variants: ParallelWriteVariant[];
  layouts: ParallelWriteLayout[];
  decodedObjectLimit: number;
};

type BenchmarkNote = {
  id: string;
  title: string;
  category: string;
  lastModified: number;
};

const target = required("TARGET_URL").replace(/\/+$/, "");
const token = required("BENCHMARK_RESULT_TOKEN");
const region = required("BENCHMARK_REGION");
const runId = required("BENCHMARK_RUN_ID");
const replicate = required("BENCHMARK_REPLICATE");
const iterations = integerValue(
  process.env.WRITE_ITERATIONS,
  6,
  1,
  20,
);

async function main() {
  const configResponse = await fetch(
    `${target}/benchmark-config.json`,
    {
      cache: "no-store",
      headers: {
        "x-benchmark-token": token,
      },
    },
  );
  if (!configResponse.ok) {
    throw new Error(
      `Config failed with ${configResponse.status}`,
    );
  }
  const colo =
    configResponse.headers.get("x-benchmark-colo") ??
      "unknown";
  const config =
    (await configResponse.json()) as Config;
  const rawKey = base64ToBytes(config.keyBase64);
  const key = await importAesGcmKey(
    rawKey,
    ["decrypt"],
  );
  rawKey.fill(0);
  const cases = PARALLEL_WRITE_VARIANTS.flatMap(
    (variant) =>
      PARALLEL_WRITE_LAYOUTS.map((layout) => ({
        name: `write-${variant}-${layout}`,
        variant,
        layout,
      })),
  );
  const samples = Object.fromEntries(
    cases.map((value) => [value.name, []]),
  ) as Record<string, unknown[]>;
  const ids: Record<string, string> = {};
  for (
    let iteration = 0;
    iteration < iterations;
    iteration += 1
  ) {
    for (const value of rotate(cases, iteration)) {
      const sample = await invokeWrite(
        value.variant,
        value.layout,
        iteration,
      );
      samples[value.name]!.push(sample);
      if (sample.success && typeof sample.id === "string") {
        ids[value.name] = sample.id;
      }
    }
  }
  const reads: Record<string, unknown> = {};
  for (const value of cases) {
    reads[value.name] = await verifyReads(
      config,
      key,
      value.variant,
      value.layout,
      ids[value.name]!,
      iterations,
    );
  }
  const result = {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    runId,
    replicate,
    region,
    colo,
    runtime: `Node ${process.version}`,
    documents: config.documents,
    iterations,
    samples,
    reads,
  };
  const resultUrl = new URL(
    "/regional-result",
    target,
  );
  resultUrl.searchParams.set("run", runId);
  resultUrl.searchParams.set("region", region);
  const response = await fetch(resultUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-benchmark-token": token,
    },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    throw new Error(
      `Result upload failed with ${response.status}`,
    );
  }
  console.log(JSON.stringify({
    stored: true,
    region,
    replicate,
    colo,
  }));
}

async function invokeWrite(
  variant: ParallelWriteVariant,
  layout: ParallelWriteLayout,
  iteration: number,
) {
  const url = new URL("/write", target);
  url.searchParams.set("region", region);
  url.searchParams.set("variant", variant);
  url.searchParams.set("layout", layout);
  url.searchParams.set(
    "iteration",
    String(iteration),
  );
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-benchmark-token": token,
      },
    });
    const elapsed = round(
      performance.now() - started,
    );
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {
        error:
          `Non-JSON ${response.status}: ` +
          text.slice(0, 200),
      };
    }
    return {
      ...body,
      success: response.ok,
      status: response.status,
      clientElapsedMs: elapsed,
    };
  } catch (error) {
    return {
      variant,
      layout,
      iteration,
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
}

async function verifyReads(
  config: Config,
  key: CryptoKey,
  variant: ParallelWriteVariant,
  layout: ParallelWriteLayout,
  id: string,
  count: number,
) {
  const readerFetch: typeof fetch = (
    input,
    init = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set("x-benchmark-token", token);
    return fetch(input, {
      ...init,
      cache: "no-store",
      headers,
    });
  };
  const reader = new ScopedJsonObjectReader(
    new EnvelopeJsonObjectReader(
      new HttpByteObjectReader(
        `${target}/data/write/${region}/${variant}/${layout}`,
        readerFetch,
        target,
      ),
      (keyId) =>
        keyId === config.keyId ? key : null,
      config.decodedObjectLimit,
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
      [BENCHMARK_COLLECTION]:
        layout as CollectionLayout,
    },
    collectionIndexes: BENCHMARK_INDEXES,
    layoutGeneration: "parallel-write-v1",
    configurationCheckedAt: Date.now(),
    layoutCheckTtlMs: Number.MAX_SAFE_INTEGER,
    channelName:
      `parallel-write-${crypto.randomUUID()}`,
  });
  try {
    const pointStarted = performance.now();
    const document = await client.get(
      BENCHMARK_COLLECTION,
      id,
    );
    const pointElapsedMs = round(
      performance.now() - pointStarted,
    );
    if (!document || document.id !== id) {
      throw new Error("Point verification failed");
    }
    const pointMetrics = client.metrics();
    client.resetMetrics();
    const query: ThimbleQuery<BenchmarkNote> = {
      version: 1,
      where: {
        and: [
          {
            field: "lastModified",
            operator: "gte",
            value: config.documents,
          },
          {
            field: "lastModified",
            operator: "lte",
            value:
              config.documents + count - 1,
          },
        ],
      },
      limit: count,
      maxScanDocuments: count,
    };
    const queryStarted = performance.now();
    const result =
      await client.queryDocuments<BenchmarkNote>(
        BENCHMARK_COLLECTION,
        query,
        ["title", "category"],
      );
    const queryElapsedMs = round(
      performance.now() - queryStarted,
    );
    if (
      result.plan !== "index" ||
      result.documents.length !== count
    ) {
      throw new Error(
        "Covered query verification failed",
      );
    }
    const queryMetrics = client.metrics();
    return {
      success: true,
      point: {
        elapsedMs: pointElapsedMs,
        remoteReads:
          pointMetrics.remoteReads,
        remoteBytes:
          pointMetrics.remoteBytes,
      },
      query: {
        elapsedMs: queryElapsedMs,
        remoteReads:
          queryMetrics.remoteReads,
        remoteBytes:
          queryMetrics.remoteBytes,
        scannedDocuments:
          result.scannedDocuments,
      },
    };
  } finally {
    client.close();
    await cache.clearAll();
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

function rotate<T>(
  values: readonly T[],
  index: number,
) {
  const offset = index % values.length;
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
}

function required(name: string) {
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

function round(value: number) {
  return Number(value.toFixed(3));
}

await main();
