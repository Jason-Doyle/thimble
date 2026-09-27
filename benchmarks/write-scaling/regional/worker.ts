import type {
  JsonDocument,
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../../../src/core.js";
import {
  ContentAddressedTrieEngine,
} from "../../../src/engines/content-trie.js";
import {
  ImmutableSnapshotEngine,
} from "../../../src/engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "../../../src/envelope-store.js";
import {
  base64ToBytes,
  DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  importAesGcmKey,
} from "../../../src/envelope.js";
import { PrefixObjectStore } from "../../../src/prefix-store.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../../src/cloudflare/r2-object-store.js";
import { scopeStoragePrefix } from "../../../src/trie-protocol.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  WRITE_SCALING_INDEX_SETS,
  WRITE_SCALING_LAYOUTS,
  benchmarkDocument,
  type WriteScalingIndexSet,
  type WriteScalingLayout,
  type WriteScalingProfile,
} from "./scenario.js";

type BenchmarkBucket = R2BucketBinding & {
  get(
    key: string,
  ): Promise<
    | {
        etag: string;
        arrayBuffer(): Promise<ArrayBuffer>;
      }
    | null
  >;
};

type Env = {
  BENCHMARK_BUCKET: BenchmarkBucket;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  BENCHMARK_KEY_BASE64: string;
  BENCHMARK_RESULT_TOKEN: string;
  BENCHMARK_SOURCE_COMMIT: string;
  BENCHMARK_HARNESS_COMMIT: string;
};

type OperationMetric = {
  count: number;
  bytes: number;
  durationMs: number;
};

type StoreMetrics = {
  reads: OperationMetric;
  writes: OperationMetric;
  preconditionFailures: number;
  byKind: Record<
    string,
    {
      reads: OperationMetric;
      writes: OperationMetric;
    }
  >;
};

let keyPromise: Promise<CryptoKey> | undefined;

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return withColo(
          json({
            sourceCommit: env.BENCHMARK_SOURCE_COMMIT,
            harnessCommit: env.BENCHMARK_HARNESS_COMMIT,
          }),
          request,
        );
      }
      if (url.pathname === "/benchmark-config.json") {
        requireToken(request, env);
        return withColo(
          json({
            sourceCommit: env.BENCHMARK_SOURCE_COMMIT,
            harnessCommit: env.BENCHMARK_HARNESS_COMMIT,
            profiles: BENCHMARK_PROFILES,
            indexSets: Object.fromEntries(
              Object.entries(
                WRITE_SCALING_INDEX_SETS,
              ).map(([name, indexes]) => [
                name,
                indexes.notes?.length ?? 0,
              ]),
            ),
            layouts: WRITE_SCALING_LAYOUTS,
            regions: BENCHMARK_REGIONS,
            decodedObjectLimit:
              DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
          }),
          request,
        );
      }
      if (url.pathname === "/write") {
        requirePost(request);
        requireToken(request, env);
        return withColo(
          json(await runWrite(env, url)),
          request,
        );
      }
      if (url.pathname.startsWith("/fixture/")) {
        requirePost(request);
        requireToken(request, env);
        return uploadFixture(request, env, url);
      }
      if (url.pathname === "/regional-result") {
        return regionalResult(request, env, url);
      }
      if (url.pathname === "/cleanup") {
        requirePost(request);
        requireToken(request, env);
        return json(await cleanupBucket(env));
      }
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof BenchmarkRequestError) {
        return json(
          { error: error.message },
          error.status,
        );
      }
      console.error(error);
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500,
      );
    }
  },
};

async function runWrite(
  env: Env,
  url: URL,
) {
  const region = requireRegion(
    url.searchParams.get("region"),
  );
  const profile = requireProfile(
    url.searchParams.get("profile"),
  );
  const indexSet = requireIndexSet(
    url.searchParams.get("indexes"),
  );
  const layout = requireLayout(
    url.searchParams.get("layout"),
  );
  const iteration = Number(
    url.searchParams.get("iteration"),
  );
  if (
    !Number.isInteger(iteration) ||
    iteration < 0 ||
    iteration > 100
  ) {
    throw new BenchmarkRequestError(
      400,
      "Iteration is invalid",
    );
  }
  const count = BENCHMARK_PROFILES[profile];
  const index =
    (iteration * 977 +
      BENCHMARK_REGIONS.indexOf(region) * 37) %
    count;
  const original = benchmarkDocument(index, count);
  const document: JsonDocument = {
    ...original,
    body:
      `${original.body} scaling ${profile} ` +
      `${indexSet} ${layout} ${iteration}`,
    lastModified: count + iteration,
  };
  const prefix =
    `write/${region}/${profile}/${indexSet}/${layout}`;
  const runtime = await createEngine(
    env,
    prefix,
    indexSet,
    layout,
  );
  const started = performance.now();
  await runtime.engine.put(
    BENCHMARK_COLLECTION,
    document.id,
    document,
  );
  return {
    region,
    profile,
    indexSet,
    indexCount:
      WRITE_SCALING_INDEX_SETS[indexSet]
        .notes?.length ?? 0,
    layout,
    iteration,
    id: document.id,
    workerIoTimerMs: round(
      performance.now() - started,
    ),
    storage: runtime.counting.publicMetrics(),
    diagnostics: runtime.engine.diagnostics(),
  };
}

async function createEngine(
  env: Env,
  prefix: string,
  indexSet: WriteScalingIndexSet,
  layout: WriteScalingLayout,
) {
  const counting = new TimingObjectStore(
    new R2ObjectStore(env.BENCHMARK_BUCKET),
  );
  const scopePrefix = scopeStoragePrefix(
    BENCHMARK_SCOPE_ID,
  );
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(
      new PrefixObjectStore(counting, prefix),
      scopePrefix,
    ),
    {
      key: await benchmarkKey(env),
      keyId: BENCHMARK_KEY_ID,
      compression: "gzip",
      objectKeyPrefix: scopePrefix,
    },
  );
  const indexes =
    WRITE_SCALING_INDEX_SETS[indexSet];
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
  return { engine, counting };
}

async function uploadFixture(
  request: Request,
  env: Env,
  url: URL,
) {
  const key = decodeObjectPath(
    url.pathname.slice("/fixture/".length),
  );
  if (
    !key.startsWith("write/") ||
    key.includes("..")
  ) {
    throw new BenchmarkRequestError(
      400,
      "Fixture path is invalid",
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > 20 * 1024 * 1024) {
    throw new BenchmarkRequestError(
      413,
      "Fixture is too large",
    );
  }
  await env.BENCHMARK_BUCKET.put(
    key,
    new Uint8Array(body),
  );
  return json({ stored: key }, 201);
}

async function regionalResult(
  request: Request,
  env: Env,
  url: URL,
) {
  requireToken(request, env);
  const run = safeName(url.searchParams.get("run"));
  const region = safeName(
    url.searchParams.get("region"),
  );
  if (!run || !region) {
    throw new BenchmarkRequestError(
      400,
      "Result path is invalid",
    );
  }
  const key = `results/${run}/${region}.json`;
  if (request.method === "POST") {
    const body = await request.text();
    if (
      new TextEncoder().encode(body).byteLength >
      5 * 1024 * 1024
    ) {
      throw new BenchmarkRequestError(
        413,
        "Result is too large",
      );
    }
    JSON.parse(body);
    await env.BENCHMARK_BUCKET.put(
      key,
      new TextEncoder().encode(body),
    );
    return json({ stored: key }, 201);
  }
  if (request.method === "GET") {
    const object = await env.BENCHMARK_BUCKET.get(key);
    if (!object) {
      return json({ error: "Result not found" }, 404);
    }
    return new Response(await object.arrayBuffer(), {
      headers: {
        "cache-control": "no-store",
        "content-type":
          "application/json; charset=utf-8",
      },
    });
  }
  throw new BenchmarkRequestError(
    405,
    "Method not allowed",
  );
}

async function cleanupBucket(env: Env) {
  let deleted = 0;
  while (true) {
    const page = await env.BENCHMARK_BUCKET.list({
      limit: 1_000,
    });
    const keys = page.objects.map(
      (object) => object.key,
    );
    if (keys.length === 0) {
      break;
    }
    await env.BENCHMARK_BUCKET.delete(keys);
    deleted += keys.length;
  }
  return { deleted };
}

function benchmarkKey(env: Env) {
  keyPromise ??= importAesGcmKey(
    base64ToBytes(env.BENCHMARK_KEY_BASE64),
    ["encrypt", "decrypt"],
  );
  return keyPromise;
}

class TimingObjectStore implements ObjectStore {
  private readonly metrics: StoreMetrics = {
    reads: metric(),
    writes: metric(),
    preconditionFailures: 0,
    byKind: {},
  };

  constructor(private readonly delegate: ObjectStore) {}

  async get(key: string): Promise<StoredObject | null> {
    const started = performance.now();
    const result = await this.delegate.get(key);
    record(
      this.metrics,
      "reads",
      key,
      result?.bytes.byteLength ?? 0,
      performance.now() - started,
    );
    return result;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ) {
    const started = performance.now();
    try {
      const result = await this.delegate.put(
        key,
        bytes,
        conditions,
      );
      record(
        this.metrics,
        "writes",
        key,
        bytes.byteLength,
        performance.now() - started,
      );
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name ===
          "PreconditionFailedError"
      ) {
        this.metrics.preconditionFailures += 1;
      }
      throw error;
    }
  }

  delete(key: string) {
    return this.delegate.delete(key);
  }

  list(prefix: string) {
    return this.delegate.list(prefix);
  }

  publicMetrics() {
    return structuredClone(this.metrics);
  }
}

function record(
  metrics: StoreMetrics,
  operation: "reads" | "writes",
  key: string,
  bytes: number,
  durationMs: number,
) {
  addMetric(
    metrics[operation],
    bytes,
    durationMs,
  );
  const kind = objectKind(key);
  metrics.byKind[kind] ??= {
    reads: metric(),
    writes: metric(),
  };
  addMetric(
    metrics.byKind[kind]![operation],
    bytes,
    durationMs,
  );
}

function addMetric(
  value: OperationMetric,
  bytes: number,
  durationMs: number,
) {
  value.count += 1;
  value.bytes += bytes;
  value.durationMs = round(
    value.durationMs + durationMs,
  );
}

function metric(): OperationMetric {
  return {
    count: 0,
    bytes: 0,
    durationMs: 0,
  };
}

function objectKind(key: string) {
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

function requireToken(
  request: Request,
  env: Env,
) {
  if (
    request.headers.get("x-benchmark-token") !==
    env.BENCHMARK_RESULT_TOKEN
  ) {
    throw new BenchmarkRequestError(
      403,
      "Benchmark token is invalid",
    );
  }
}

function requirePost(request: Request) {
  if (request.method !== "POST") {
    throw new BenchmarkRequestError(
      405,
      "Method not allowed",
    );
  }
}

function requireRegion(value: string | null) {
  if (
    !BENCHMARK_REGIONS.includes(
      value as (typeof BENCHMARK_REGIONS)[number],
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Region is invalid",
    );
  }
  return value as (typeof BENCHMARK_REGIONS)[number];
}

function requireProfile(
  value: string | null,
): WriteScalingProfile {
  if (
    !Object.hasOwn(BENCHMARK_PROFILES, value ?? "")
  ) {
    throw new BenchmarkRequestError(
      400,
      "Profile is invalid",
    );
  }
  return value as WriteScalingProfile;
}

function requireIndexSet(
  value: string | null,
): WriteScalingIndexSet {
  if (
    !Object.hasOwn(
      WRITE_SCALING_INDEX_SETS,
      value ?? "",
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Index set is invalid",
    );
  }
  return value as WriteScalingIndexSet;
}

function requireLayout(
  value: string | null,
): WriteScalingLayout {
  if (
    !WRITE_SCALING_LAYOUTS.includes(
      value as WriteScalingLayout,
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Layout is invalid",
    );
  }
  return value as WriteScalingLayout;
}

function safeName(value: string | null) {
  return value &&
    /^[a-z0-9-]{1,80}$/i.test(value)
    ? value
    : null;
}

function decodeObjectPath(encoded: string) {
  try {
    return encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw new BenchmarkRequestError(
      400,
      "Fixture path encoding is invalid",
    );
  }
}

function withColo(
  response: Response,
  request: Request,
) {
  const colo =
    (
      request as Request & {
        cf?: { colo?: string };
      }
    ).cf?.colo ?? "unknown";
  const headers = new Headers(response.headers);
  headers.set("x-benchmark-colo", colo);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(
  value: unknown,
  status = 200,
) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function round(value: number) {
  return Number(value.toFixed(3));
}

class BenchmarkRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
