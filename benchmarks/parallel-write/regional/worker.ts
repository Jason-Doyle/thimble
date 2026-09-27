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
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  PARALLEL_WRITE_DOCUMENTS,
  PARALLEL_WRITE_LAYOUTS,
  PARALLEL_WRITE_VARIANTS,
  benchmarkDocument,
  type ParallelWriteLayout,
  type ParallelWriteVariant,
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

type StoreMetrics = {
  reads: number;
  readBytes: number;
  writes: number;
  writtenBytes: number;
  preconditionFailures: number;
  activeReads: number;
  activeWrites: number;
  maximumConcurrentReads: number;
  maximumConcurrentWrites: number;
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
            keyBase64: env.BENCHMARK_KEY_BASE64,
            keyId: BENCHMARK_KEY_ID,
            scopeId: BENCHMARK_SCOPE_ID,
            collection: BENCHMARK_COLLECTION,
            documents: PARALLEL_WRITE_DOCUMENTS,
            indexes: BENCHMARK_INDEXES,
            variants: PARALLEL_WRITE_VARIANTS,
            layouts: PARALLEL_WRITE_LAYOUTS,
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
      if (url.pathname.startsWith("/data/")) {
        requireToken(request, env);
        return withColo(
          await serveObject(
            request,
            env,
            url.pathname.slice("/data/".length),
          ),
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
  const variant = requireVariant(
    url.searchParams.get("variant"),
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
  const prefix =
    `write/${region}/${variant}/${layout}`;
  const runtime = await createEngine(
    env,
    prefix,
    variant,
    layout,
  );
  const index =
    (iteration * 997 +
      BENCHMARK_REGIONS.indexOf(region) * 37) %
    PARALLEL_WRITE_DOCUMENTS;
  const original = benchmarkDocument(
    index,
    PARALLEL_WRITE_DOCUMENTS,
  );
  const document: JsonDocument = {
    ...original,
    body:
      `${original.body} parallel ${variant} ` +
      `${region} ${iteration}`,
    lastModified:
      PARALLEL_WRITE_DOCUMENTS + iteration,
  };
  const started = performance.now();
  await runtime.engine.put(
    BENCHMARK_COLLECTION,
    document.id,
    document,
  );
  return {
    region,
    variant,
    layout,
    iteration,
    id: document.id,
    workerIoTimerMs: round(
      performance.now() - started,
    ),
    storage: publicMetrics(
      runtime.counting.metrics,
    ),
    diagnostics: runtime.engine.diagnostics(),
  };
}

async function serveObject(
  request: Request,
  env: Env,
  encodedPath: string,
) {
  if (request.method !== "GET") {
    throw new BenchmarkRequestError(
      405,
      "Method not allowed",
    );
  }
  const key = decodeObjectPath(encodedPath);
  if (
    !/^write\/[a-z0-9-]+\/(sequential|parallel)\/(snapshot|trie)\/scopes\/benchmark\/.+/.test(
      key,
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Object path is invalid",
    );
  }
  const object = await env.BENCHMARK_BUCKET.get(key);
  if (!object) {
    return new Response(null, {
      status: 404,
      headers: {
        "cache-control": "no-store",
      },
    });
  }
  const etag = quoteEtag(object.etag);
  if (
    request.headers.get("if-none-match") === etag
  ) {
    return new Response(null, {
      status: 304,
      headers: {
        "cache-control": "no-store",
        etag,
      },
    });
  }
  return new Response(await object.arrayBuffer(), {
    headers: {
      "cache-control": "no-store",
      "content-type":
        "application/vnd.thimbledb.object",
      etag,
    },
  });
}

async function createEngine(
  env: Env,
  prefix: string,
  variant: ParallelWriteVariant,
  layout: ParallelWriteLayout,
) {
  const counting = new CountingObjectStore(
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
  const writeOptions = {
    mode: variant,
    maximumConcurrency: 3,
  } as const;
  const engine =
    layout === "snapshot"
      ? new ImmutableSnapshotEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
          false,
          writeOptions,
        )
      : new ContentAddressedTrieEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
          false,
          writeOptions,
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

class CountingObjectStore implements ObjectStore {
  readonly metrics: StoreMetrics = {
    reads: 0,
    readBytes: 0,
    writes: 0,
    writtenBytes: 0,
    preconditionFailures: 0,
    activeReads: 0,
    activeWrites: 0,
    maximumConcurrentReads: 0,
    maximumConcurrentWrites: 0,
  };

  constructor(private readonly delegate: ObjectStore) {}

  async get(key: string): Promise<StoredObject | null> {
    this.metrics.activeReads += 1;
    this.metrics.maximumConcurrentReads = Math.max(
      this.metrics.maximumConcurrentReads,
      this.metrics.activeReads,
    );
    try {
      const result = await this.delegate.get(key);
      this.metrics.reads += 1;
      this.metrics.readBytes +=
        result?.bytes.byteLength ?? 0;
      return result;
    } finally {
      this.metrics.activeReads -= 1;
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ) {
    this.metrics.activeWrites += 1;
    this.metrics.maximumConcurrentWrites =
      Math.max(
        this.metrics.maximumConcurrentWrites,
        this.metrics.activeWrites,
      );
    try {
      const result = await this.delegate.put(
        key,
        bytes,
        conditions,
      );
      this.metrics.writes += 1;
      this.metrics.writtenBytes +=
        bytes.byteLength;
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
    } finally {
      this.metrics.activeWrites -= 1;
    }
  }

  delete(key: string) {
    return this.delegate.delete(key);
  }

  list(prefix: string) {
    return this.delegate.list(prefix);
  }
}

function publicMetrics(metrics: StoreMetrics) {
  return {
    reads: metrics.reads,
    readBytes: metrics.readBytes,
    writes: metrics.writes,
    writtenBytes: metrics.writtenBytes,
    preconditionFailures:
      metrics.preconditionFailures,
    maximumConcurrentReads:
      metrics.maximumConcurrentReads,
    maximumConcurrentWrites:
      metrics.maximumConcurrentWrites,
  };
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

function requireVariant(
  value: string | null,
): ParallelWriteVariant {
  if (
    !PARALLEL_WRITE_VARIANTS.includes(
      value as ParallelWriteVariant,
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Variant is invalid",
    );
  }
  return value as ParallelWriteVariant;
}

function requireLayout(
  value: string | null,
): ParallelWriteLayout {
  if (
    !PARALLEL_WRITE_LAYOUTS.includes(
      value as ParallelWriteLayout,
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Layout is invalid",
    );
  }
  return value as ParallelWriteLayout;
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
      "Object path encoding is invalid",
    );
  }
}

function quoteEtag(etag: string) {
  return `"${etag
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "")}"`;
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
