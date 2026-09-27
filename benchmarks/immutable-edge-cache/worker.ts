import {
  BoundedReadError,
  type ObjectStore,
  type PutConditions,
  type StoredObject,
} from "../../src/core.js";
import {
  ContentAddressedTrieEngine,
} from "../../src/engines/content-trie.js";
import {
  ImmutableSnapshotEngine,
} from "../../src/engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "../../src/envelope-store.js";
import {
  base64ToBytes,
  DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  importAesGcmKey,
} from "../../src/envelope.js";
import {
  ExperimentalImmutableObjectEdgeCacheStore,
  type ExperimentalEdgeCacheMetrics,
  type ExperimentalResponseCache,
} from "../../src/experimental/immutable-object-edge-cache.js";
import { PrefixObjectStore } from "../../src/prefix-store.js";
import { readPointBundle } from "../../src/read-bundle.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../src/cloudflare/r2-object-store.js";
import { scopeStoragePrefix } from "../../src/trie-protocol.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkExpectations,
  benchmarkPointIds,
  type BenchmarkLayout,
  type BenchmarkProfile,
} from "../current-regional/scenario.js";

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

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type StoreCounters = {
  reads: number;
  readBytes: number;
  writes: number;
  writtenBytes: number;
  deletes: number;
  lists: number;
  preconditionFailures: number;
};

let keyPromise: Promise<CryptoKey> | undefined;

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContextLike,
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
        requireBenchmarkToken(request, env);
        return withColo(
          json(benchmarkConfig(env)),
          request,
        );
      }
      if (url.pathname === "/regional-result") {
        return regionalResult(request, env, url);
      }
      if (url.pathname === "/fixture-inventory") {
        requireBenchmarkToken(request, env);
        return json(await fixtureInventory(env));
      }
      if (url.pathname.startsWith("/fixture/")) {
        requireBenchmarkToken(request, env);
        return uploadFixture(request, env, url);
      }
      if (url.pathname.startsWith("/baseline-data/")) {
        requireBenchmarkToken(request, env);
        return serveDataObject(
          request,
          env,
          context,
          url.pathname.slice("/baseline-data/".length),
          false,
        );
      }
      if (url.pathname.startsWith("/edge-data/")) {
        requireBenchmarkToken(request, env);
        return serveDataObject(
          request,
          env,
          context,
          url.pathname.slice("/edge-data/".length),
          true,
        );
      }
      if (url.pathname.startsWith("/baseline-bundle/")) {
        requireBenchmarkToken(request, env);
        return serveBundle(
          request,
          env,
          context,
          url,
          false,
        );
      }
      if (url.pathname.startsWith("/edge-bundle/")) {
        requireBenchmarkToken(request, env);
        return serveBundle(
          request,
          env,
          context,
          url,
          true,
        );
      }
      if (url.pathname === "/cleanup") {
        if (request.method !== "POST") {
          throw new BenchmarkRequestError(
            405,
            "Method not allowed",
          );
        }
        requireBenchmarkToken(request, env);
        return json(await cleanupBucket(env));
      }
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof BenchmarkRequestError) {
        return json({ error: error.message }, error.status);
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

function benchmarkConfig(env: Env) {
  return {
    sourceCommit: env.BENCHMARK_SOURCE_COMMIT,
    harnessCommit: env.BENCHMARK_HARNESS_COMMIT,
    keyBase64: env.BENCHMARK_KEY_BASE64,
    keyId: BENCHMARK_KEY_ID,
    scopeId: BENCHMARK_SCOPE_ID,
    collection: BENCHMARK_COLLECTION,
    decodedObjectLimit:
      DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
    indexes: BENCHMARK_INDEXES,
    regions: BENCHMARK_REGIONS,
    profiles: Object.fromEntries(
      Object.entries(BENCHMARK_PROFILES).map(
        ([profile, documents]) => [
          profile,
          {
            documents,
            pointIds: benchmarkPointIds(documents),
            expected: benchmarkExpectations(documents),
          },
        ],
      ),
    ),
  };
}

async function serveDataObject(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  encodedKey: string,
  edge: boolean,
): Promise<Response> {
  if (request.method !== "GET") {
    throw new BenchmarkRequestError(
      405,
      "Method not allowed",
    );
  }
  const fullKey = decodeObjectPath(encodedKey);
  const parsed = parseReadKey(fullKey);
  const counting = new CountingObjectStore(
    new R2ObjectStore(env.BENCHMARK_BUCKET),
  );
  const dataStore = new PrefixObjectStore(
    counting,
    parsed.storageNamespace,
  );
  const cached = edge
    ? edgeStore(
        dataStore,
        request,
        context,
        parsed.storageNamespace,
      )
    : null;
  const store = cached ?? dataStore;
  const object = await store.get(parsed.relativeKey);
  if (!object) {
    return withColo(
      withMetrics(
        new Response(null, { status: 404 }),
        counting.metrics,
        cached?.metrics,
      ),
      request,
    );
  }
  const etag = quoteEtag(object.etag);
  const response =
    normaliseEtag(request.headers.get("if-none-match")) ===
      normaliseEtag(etag)
      ? new Response(null, {
          status: 304,
          headers: { etag },
        })
      : new Response(object.bytes.slice(), {
          headers: {
            "cache-control": "private, no-cache",
            "content-type":
              "application/vnd.thimbledb.object",
            etag,
          },
        });
  return withColo(
    withMetrics(
      response,
      counting.metrics,
      cached?.metrics,
    ),
    request,
  );
}

async function serveBundle(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  url: URL,
  edge: boolean,
): Promise<Response> {
  if (request.method !== "GET") {
    throw new BenchmarkRequestError(
      405,
      "Method not allowed",
    );
  }
  const prefix = edge ? "edge" : "baseline";
  const match = new RegExp(
    `^/${prefix}-bundle/(small|medium|large)/(snapshot|trie)/benchmark/notes/([^/]+)$`,
  ).exec(url.pathname);
  if (!match) {
    throw new BenchmarkRequestError(
      400,
      "Invalid bundle path",
    );
  }
  const profile = requireProfile(match[1]);
  const layout = requireLayout(match[2]);
  const id = decodeURIComponent(match[3]!);
  const runtime = await createEngine(
    env,
    request,
    context,
    `read/${profile}/${layout}`,
    layout,
    edge,
  );
  try {
    const bundle = await readPointBundle(
      runtime.engine,
      BENCHMARK_COLLECTION,
      id,
    );
    return withColo(
      withMetrics(
        new Response(JSON.stringify(bundle), {
          headers: {
            "cache-control": "no-store",
            "content-type":
              "application/json; charset=utf-8",
          },
        }),
        runtime.counting.metrics,
        runtime.cache?.metrics,
      ),
      request,
    );
  } catch (error) {
    if (error instanceof BoundedReadError) {
      return withColo(
        withMetrics(
          json({ error: error.message }, 413),
          runtime.counting.metrics,
          runtime.cache?.metrics,
        ),
        request,
      );
    }
    throw error;
  }
}

async function createEngine(
  env: Env,
  request: Request,
  context: ExecutionContextLike,
  storageNamespace: string,
  layout: BenchmarkLayout,
  edge: boolean,
) {
  const counting = new CountingObjectStore(
    new R2ObjectStore(env.BENCHMARK_BUCKET),
  );
  const dataStore = new PrefixObjectStore(
    counting,
    storageNamespace,
  );
  const cache = edge
    ? edgeStore(
        dataStore,
        request,
        context,
        storageNamespace,
      )
    : null;
  const scopePrefix = scopeStoragePrefix(
    BENCHMARK_SCOPE_ID,
  );
  const key = await benchmarkKey(env);
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(
      cache ?? dataStore,
      scopePrefix,
    ),
    {
      key,
      keyId: BENCHMARK_KEY_ID,
      compression: "gzip",
      objectKeyPrefix: scopePrefix,
    },
  );
  const engine =
    layout === "snapshot"
      ? new ImmutableSnapshotEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
        )
      : new ContentAddressedTrieEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
        );
  return { engine, counting, cache };
}

function edgeStore(
  delegate: ObjectStore,
  request: Request,
  context: ExecutionContextLike,
  storageNamespace: string,
) {
  const cacheNamespace = requireCacheNamespace(request);
  const cache = (
    caches as unknown as {
      default: ExperimentalResponseCache;
    }
  ).default;
  return new ExperimentalImmutableObjectEdgeCacheStore(
    delegate,
    {
      cache,
      origin: request.url,
      cacheNamespace,
      storageNamespace,
      defer: (promise) => context.waitUntil(promise),
    },
  );
}

async function uploadFixture(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    throw new BenchmarkRequestError(
      405,
      "Method not allowed",
    );
  }
  const key = decodeObjectPath(
    url.pathname.slice("/fixture/".length),
  );
  parseReadKey(key);
  const declared = Number(
    request.headers.get("content-length") ?? "0",
  );
  if (declared > 20 * 1024 * 1024) {
    throw new BenchmarkRequestError(
      413,
      "Fixture is too large",
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

async function fixtureInventory(
  env: Env,
): Promise<{ objects: number }> {
  let objects = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BENCHMARK_BUCKET.list({
      prefix: "read/",
      cursor,
      limit: 1_000,
    });
    objects += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects };
}

async function regionalResult(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  requireBenchmarkToken(request, env);
  const run = safeName(url.searchParams.get("run"));
  const region = safeName(url.searchParams.get("region"));
  if (!run || !region) {
    throw new BenchmarkRequestError(
      400,
      "Invalid result path",
    );
  }
  const key = `results/${run}/${region}.json`;
  if (request.method === "POST") {
    const declared = Number(
      request.headers.get("content-length") ?? "0",
    );
    if (declared > 10 * 1024 * 1024) {
      throw new BenchmarkRequestError(
        413,
        "Result is too large",
      );
    }
    const body = await request.text();
    if (
      new TextEncoder().encode(body).byteLength >
      10 * 1024 * 1024
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
        "content-type": "application/json; charset=utf-8",
      },
    });
  }
  throw new BenchmarkRequestError(
    405,
    "Method not allowed",
  );
}

async function cleanupBucket(
  env: Env,
): Promise<{ deleted: number }> {
  let deleted = 0;
  while (true) {
    const page = await env.BENCHMARK_BUCKET.list({
      limit: 1_000,
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length === 0) {
      break;
    }
    await env.BENCHMARK_BUCKET.delete(keys);
    deleted += keys.length;
  }
  return { deleted };
}

function parseReadKey(key: string): {
  profile: BenchmarkProfile;
  layout: BenchmarkLayout;
  storageNamespace: string;
  relativeKey: string;
} {
  const match =
    /^read\/(small|medium|large)\/(snapshot|trie)\/(.+)$/.exec(
      key,
    );
  if (!match) {
    throw new BenchmarkRequestError(
      400,
      "Invalid object path",
    );
  }
  const profile = requireProfile(match[1]);
  const layout = requireLayout(match[2]);
  const relativeKey = match[3]!;
  const expectedPrefix =
    `scopes/${BENCHMARK_SCOPE_ID}/` +
    (layout === "snapshot"
      ? "content-snapshot/"
      : "content-trie/");
  if (
    !relativeKey.startsWith(expectedPrefix) ||
    relativeKey.includes("..")
  ) {
    throw new BenchmarkRequestError(
      400,
      "Invalid object path",
    );
  }
  return {
    profile,
    layout,
    storageNamespace: `read/${profile}/${layout}`,
    relativeKey,
  };
}

function decodeObjectPath(encoded: string): string {
  try {
    return encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw new BenchmarkRequestError(
      400,
      "Invalid object path encoding",
    );
  }
}

function benchmarkKey(env: Env): Promise<CryptoKey> {
  keyPromise ??= importAesGcmKey(
    base64ToBytes(env.BENCHMARK_KEY_BASE64),
    ["decrypt"],
  );
  return keyPromise;
}

class CountingObjectStore implements ObjectStore {
  readonly metrics: StoreCounters = {
    reads: 0,
    readBytes: 0,
    writes: 0,
    writtenBytes: 0,
    deletes: 0,
    lists: 0,
    preconditionFailures: 0,
  };

  constructor(private readonly delegate: ObjectStore) {}

  async get(key: string): Promise<StoredObject | null> {
    const result = await this.delegate.get(key);
    this.metrics.reads += 1;
    this.metrics.readBytes += result?.bytes.byteLength ?? 0;
    return result;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    const result = await this.delegate.put(
      key,
      bytes,
      conditions,
    );
    this.metrics.writes += 1;
    this.metrics.writtenBytes += bytes.byteLength;
    return result;
  }

  async delete(key: string): Promise<void> {
    await this.delegate.delete(key);
    this.metrics.deletes += 1;
  }

  async list(prefix: string): Promise<string[]> {
    const keys = await this.delegate.list(prefix);
    this.metrics.lists += 1;
    return keys;
  }
}

function requireBenchmarkToken(
  request: Request,
  env: Env,
): void {
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

function requireCacheNamespace(request: Request): string {
  const value = request.headers.get(
    "x-benchmark-cache-namespace",
  );
  if (
    !value ||
    !/^[a-z0-9._/-]{1,160}$/i.test(value)
  ) {
    throw new BenchmarkRequestError(
      400,
      "Cache namespace is invalid",
    );
  }
  return value;
}

function requireProfile(
  value: string | null | undefined,
): BenchmarkProfile {
  if (
    value !== "small" &&
    value !== "medium" &&
    value !== "large"
  ) {
    throw new BenchmarkRequestError(
      400,
      "Invalid benchmark profile",
    );
  }
  return value;
}

function requireLayout(
  value: string | null | undefined,
): BenchmarkLayout {
  if (value !== "snapshot" && value !== "trie") {
    throw new BenchmarkRequestError(
      400,
      "Invalid benchmark layout",
    );
  }
  return value;
}

function safeName(value: string | null): string | null {
  return value && /^[a-z0-9-]{1,80}$/.test(value)
    ? value
    : null;
}

function withMetrics(
  response: Response,
  storage: StoreCounters,
  cache?: ExperimentalEdgeCacheMetrics,
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "x-benchmark-storage-reads",
    String(storage.reads),
  );
  headers.set(
    "x-benchmark-storage-bytes",
    String(storage.readBytes),
  );
  headers.set(
    "x-benchmark-edge-cache-hits",
    String(cache?.hits ?? 0),
  );
  headers.set(
    "x-benchmark-edge-cache-hit-bytes",
    String(cache?.hitBytes ?? 0),
  );
  headers.set(
    "x-benchmark-edge-cache-misses",
    String(cache?.misses ?? 0),
  );
  headers.set(
    "x-benchmark-edge-cache-bypasses",
    String(cache?.bypasses ?? 0),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function quoteEtag(etag: string): string {
  return `"${normaliseEtag(etag)}"`;
}

function normaliseEtag(etag: string | null): string {
  return (etag ?? "")
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "");
}

function withColo(
  response: Response,
  request: Request,
): Response {
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
): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

class BenchmarkRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
