import type {
  JsonDocument,
  ObjectStore,
  PutConditions,
  StoredObject,
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
  decodeEnvelope,
  DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  importAesGcmKey,
} from "../../src/envelope.js";
import { PrefixObjectStore } from "../../src/prefix-store.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../src/cloudflare/r2-object-store.js";
import { readPointBundle } from "../../src/read-bundle.js";
import { scopeStoragePrefix } from "../../src/trie-protocol.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkExpectations,
  benchmarkPointIds,
  type BenchmarkLayout,
  type BenchmarkProfile,
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
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/benchmark-config.json") {
        return withColo(
          json(await benchmarkConfig(env)),
          request,
        );
      }
      if (url.pathname === "/regional-result") {
        return regionalResult(request, env, url);
      }
      if (url.pathname === "/write") {
        if (request.method !== "POST") {
          return json({ error: "Method not allowed" }, 405);
        }
        requireBenchmarkToken(request, env);
        return withColo(
          json(await runWrite(request, env, url)),
          request,
        );
      }
      if (url.pathname === "/limit-check") {
        return withColo(
          json(await runLimitCheck(env)),
          request,
        );
      }
      if (url.pathname === "/cleanup") {
        if (request.method !== "POST") {
          return json({ error: "Method not allowed" }, 405);
        }
        requireBenchmarkToken(request, env);
        return json(await cleanupBucket(env));
      }
      if (url.pathname.startsWith("/data/")) {
        return serveObject(request, env, url.pathname.slice(6));
      }
      if (url.pathname.startsWith("/bundle/")) {
        return serveBundle(request, env, url);
      }
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof BenchmarkAccessError) {
        return json({ error: error.message }, 403);
      }
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

async function benchmarkConfig(env: Env) {
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

async function serveObject(
  request: Request,
  env: Env,
  encodedKey: string,
): Promise<Response> {
  const key = decodeURIComponent(encodedKey);
  if (
    !/^read\/(small|medium|large)\/(snapshot|trie)\/scopes\/benchmark\/.+/.test(
      key,
    )
  ) {
    return json({ error: "Invalid object path" }, 400);
  }
  const object = await env.BENCHMARK_BUCKET.get(key);
  if (!object) {
    return json({ error: "Object not found" }, 404);
  }
  const etag = quoteEtag(object.etag);
  if (request.headers.get("if-none-match") === etag) {
    return withColo(
      new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": "no-store",
        },
      }),
      request,
    );
  }
  return withColo(
    new Response(await object.arrayBuffer(), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        etag,
      },
    }),
    request,
  );
}

async function serveBundle(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  const match =
    /^\/bundle\/(small|medium|large)\/(snapshot|trie)\/benchmark\/notes\/([^/]+)$/.exec(
      url.pathname,
    );
  if (!match) {
    return json({ error: "Invalid bundle path" }, 400);
  }
  const profile = requireProfile(match[1]);
  const layout = requireLayout(match[2]);
  const id = decodeURIComponent(match[3]!);
  const runtime = await createEngine(
    env,
    `read/${profile}/${layout}`,
    layout,
  );
  const bundle = await readPointBundle(
    runtime.engine,
    BENCHMARK_COLLECTION,
    id,
  );
  const body = JSON.stringify(bundle);
  return withColo(
    new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-benchmark-storage-reads": String(
          runtime.store.metrics.reads,
        ),
        "x-benchmark-storage-bytes": String(
          runtime.store.metrics.readBytes,
        ),
      },
    }),
    request,
  );
}

async function runWrite(
  request: Request,
  env: Env,
  url: URL,
): Promise<unknown> {
  const layout = requireLayout(url.searchParams.get("layout"));
  const mode = url.searchParams.get("mode");
  const region = requireRegion(
    url.searchParams.get("region"),
  );
  const replicate = safeName(
    url.searchParams.get("replicate"),
  );
  const iteration = Number(
    url.searchParams.get("iteration") ?? "-1",
  );
  if (
    (mode !== "single" && mode !== "contention") ||
    !Number.isInteger(iteration) ||
    iteration < 0
  ) {
    throw new Error("Invalid write benchmark request");
  }
  const prefix =
    mode === "single"
      ? `write/single/${region}/${layout}`
      : `write/contention/${replicate}/${layout}`;
  if (mode === "contention" && !replicate) {
    throw new Error("Contention writes require a replicate");
  }
  const count = BENCHMARK_PROFILES.large;
  const documentIndex =
    (iteration * 997 +
      BENCHMARK_REGIONS.indexOf(
        region,
      ) *
        37) %
    count;
  const original = benchmarkDocument(documentIndex, count);
  const document: JsonDocument = {
    ...original,
    body:
      `${original.body} write ${mode} ${replicate} ` +
      `${region} ${iteration}`,
    lastModified: count + iteration,
  };
  const runtime = await createEngine(env, prefix, layout);
  const started = performance.now();
  await runtime.engine.put(
    BENCHMARK_COLLECTION,
    document.id,
    document,
  );
  return {
    layout,
    mode,
    region,
    replicate,
    iteration,
    id: document.id,
    workerIoTimerMs: round(performance.now() - started),
    storage: runtime.store.metrics,
    diagnostics: runtime.engine.diagnostics(),
  };
}

async function runLimitCheck(env: Env): Promise<unknown> {
  const object = await env.BENCHMARK_BUCKET.get(
    "limit/oversized.tdb",
  );
  if (!object) {
    throw new Error("Decoded-limit fixture is missing");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    await decodeEnvelope(
      bytes,
      undefined,
      undefined,
      {
        maximumDecodedBytes:
          DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
      },
    );
  } catch (error) {
    return {
      rejected: true,
      limit: DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
      storedBytes: bytes.byteLength,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
  throw new Error("Oversized decoded fixture was accepted");
}

async function regionalResult(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  requireBenchmarkToken(request, env);
  const run = safeName(url.searchParams.get("run"));
  const mode = safeName(url.searchParams.get("mode"));
  const region = safeName(url.searchParams.get("region"));
  if (!run || !mode || !region) {
    return json({ error: "Invalid result path" }, 400);
  }
  const key = `results/${run}/${mode}/${region}.json`;
  if (request.method === "POST") {
    const declared = Number(
      request.headers.get("content-length") ?? "0",
    );
    if (declared > 5 * 1024 * 1024) {
      return json({ error: "Result is too large" }, 413);
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 5 * 1024 * 1024) {
      return json({ error: "Result is too large" }, 413);
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
  return json({ error: "Method not allowed" }, 405);
}

async function cleanupBucket(env: Env): Promise<unknown> {
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

async function createEngine(
  env: Env,
  prefix: string,
  layout: BenchmarkLayout,
) {
  const counting = new CountingObjectStore(
    new R2ObjectStore(env.BENCHMARK_BUCKET),
  );
  const data = new PrefixObjectStore(counting, prefix);
  const scopePrefix = scopeStoragePrefix(
    BENCHMARK_SCOPE_ID,
  );
  const key = await benchmarkKey(env);
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(data, scopePrefix),
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
  return { engine, store: counting };
}

function benchmarkKey(env: Env): Promise<CryptoKey> {
  keyPromise ??= importAesGcmKey(
    base64ToBytes(env.BENCHMARK_KEY_BASE64),
    ["encrypt", "decrypt"],
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
    try {
      const result = await this.delegate.put(
        key,
        bytes,
        conditions,
      );
      this.metrics.writes += 1;
      this.metrics.writtenBytes += bytes.byteLength;
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "PreconditionFailedError"
      ) {
        this.metrics.preconditionFailures += 1;
      }
      throw error;
    }
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

function requireBenchmarkToken(request: Request, env: Env): void {
  if (
    request.headers.get("x-benchmark-token") !==
    env.BENCHMARK_RESULT_TOKEN
  ) {
    throw new BenchmarkAccessError(
      "Benchmark token is invalid",
    );
  }
}

class BenchmarkAccessError extends Error {}

function requireProfile(
  value: string | null | undefined,
): BenchmarkProfile {
  if (
    value !== "small" &&
    value !== "medium" &&
    value !== "large"
  ) {
    throw new Error("Invalid benchmark profile");
  }
  return value;
}

function requireLayout(
  value: string | null | undefined,
): BenchmarkLayout {
  if (value !== "snapshot" && value !== "trie") {
    throw new Error("Invalid benchmark layout");
  }
  return value;
}

function requireRegion(
  value: string | null | undefined,
): (typeof BENCHMARK_REGIONS)[number] {
  if (
    !BENCHMARK_REGIONS.includes(
      value as (typeof BENCHMARK_REGIONS)[number],
    )
  ) {
    throw new Error("Invalid benchmark region");
  }
  return value as (typeof BENCHMARK_REGIONS)[number];
}

function safeName(value: string | null): string | null {
  return value && /^[a-z0-9-]{1,80}$/.test(value)
    ? value
    : null;
}

function quoteEtag(etag: string): string {
  const raw = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  return `"${raw}"`;
}

function withColo(response: Response, request: Request): Response {
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
