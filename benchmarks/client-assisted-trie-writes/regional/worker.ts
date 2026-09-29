import type {
  JsonDocument,
  JsonValue,
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../../../src/core.js";
import { ContentAddressedTrieEngine } from "../../../src/engines/content-trie.js";
import { EnvelopeObjectStore } from "../../../src/envelope-store.js";
import {
  base64ToBytes,
  DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  importAesGcmKey,
} from "../../../src/envelope.js";
import {
  applyClientAssistedTrieWrite,
  type ClientTrieWriteContext,
} from "../../../src/experimental/client-write-context.js";
import { PrefixObjectStore } from "../../../src/prefix-store.js";
import {
  decodeJson,
  stableStringify,
} from "../../../src/shared-utils.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../../src/cloudflare/r2-object-store.js";
import {
  scopeStoragePrefix,
  trieHeadKey,
} from "../../../src/trie-protocol.js";
import { captureClientTrieWriteContext } from "../context.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  CLIENT_WRITE_INDEX_SETS,
  CLIENT_WRITE_MODES,
  benchmarkDocument,
  type ClientWriteIndexSet,
  type ClientWriteMode,
  type ClientWriteProfile,
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
let contextKeyPromise: Promise<CryptoKey> | undefined;

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
                CLIENT_WRITE_INDEX_SETS,
              ).map(([name, indexes]) => [
                name,
                indexes.notes?.length ?? 0,
              ]),
            ),
            modes: CLIENT_WRITE_MODES,
            regions: BENCHMARK_REGIONS,
            decodedObjectLimit:
              DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
          }),
          request,
        );
      }
      if (url.pathname === "/context") {
        requirePost(request);
        requireToken(request, env);
        return withColo(
          json(await runContext(env, url)),
          request,
        );
      }
      if (url.pathname === "/write") {
        requirePost(request);
        requireToken(request, env);
        return withColo(
          json(await runWrite(request, env, url)),
          request,
        );
      }
      if (url.pathname === "/verify") {
        requireToken(request, env);
        return withColo(
          json(await verifyEquivalent(env, url)),
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

async function runContext(
  env: Env,
  url: URL,
) {
  const parameters = writeParameters(url);
  const runtime = await createRuntime(
    env,
    prefixFor(parameters, "tree-context"),
    parameters.indexSet,
  );
  const started = performance.now();
  const result = await captureClientTrieWriteContext({
    store: runtime.store,
    addressNode: sha256Hex,
    sign: (bytes) =>
      contextSignature(env, bytes),
    scopeId: BENCHMARK_SCOPE_ID,
    collection: BENCHMARK_COLLECTION,
    documentId: parameters.document.id,
    layoutGeneration: "client-write-v1",
    indexConfiguration:
      CLIENT_WRITE_INDEX_SETS[
        parameters.indexSet
      ],
    includeIndexes: false,
  });
  return {
    ...parameters.public,
    context: result.context,
    requestBytes: result.requestBytes,
    contextWorkerIoTimerMs: round(
      performance.now() - started,
    ),
    contextStorage:
      runtime.counting.publicMetrics(),
  };
}

async function runWrite(
  request: Request,
  env: Env,
  url: URL,
) {
  const parameters = writeParameters(url);
  const mode = requireMode(
    url.searchParams.get("mode"),
  );
  let context: ClientTrieWriteContext | undefined;
  let requestBytes = 0;
  if (mode === "tree-context") {
    const body = await boundedText(
      request,
      256 * 1024,
    );
    requestBytes = new TextEncoder().encode(
      body,
    ).byteLength;
    context = JSON.parse(
      body,
    ) as ClientTrieWriteContext;
  }
  const runtime = await createRuntime(
    env,
    prefixFor(parameters, mode),
    parameters.indexSet,
  );
  const started = performance.now();
  const assisted =
    mode === "tree-context"
      ? await applyClientAssistedTrieWrite({
          store: runtime.store,
          addressNode: sha256Hex,
          verifySignature: (bytes) =>
            contextSignature(env, bytes),
          scopeId: BENCHMARK_SCOPE_ID,
          collection: BENCHMARK_COLLECTION,
          layoutGeneration: "client-write-v1",
          document: parameters.document,
          context,
          indexConfiguration:
            CLIENT_WRITE_INDEX_SETS[
              parameters.indexSet
            ],
        })
      : null;
  if (mode === "baseline") {
    await runtime.engine.put(
      BENCHMARK_COLLECTION,
      parameters.document.id,
      parameters.document,
    );
  }
  return {
    ...parameters.public,
    mode,
    requestBytes,
    workerIoTimerMs: round(
      performance.now() - started,
    ),
    storage: runtime.counting.publicMetrics(),
    diagnostics: runtime.engine.diagnostics(),
    assisted,
  };
}

async function verifyEquivalent(
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
  const parameters = {
    region,
    profile,
    indexSet,
    document: benchmarkDocument(
      0,
      BENCHMARK_PROFILES[profile],
    ),
    public: {},
  };
  const baseline = await createRuntime(
    env,
    prefixFor(parameters, "baseline"),
    indexSet,
  );
  const assisted = await createRuntime(
    env,
    prefixFor(parameters, "tree-context"),
    indexSet,
  );
  const [baselineDocuments, assistedDocuments] =
    await Promise.all([
      baseline.engine.exportStored(
        BENCHMARK_COLLECTION,
      ),
      assisted.engine.exportStored(
        BENCHMARK_COLLECTION,
      ),
    ]);
  const [baselineHead, assistedHead] =
    await Promise.all([
      baseline.store.get(
        trieHeadKey(BENCHMARK_COLLECTION),
      ),
      assisted.store.get(
        trieHeadKey(BENCHMARK_COLLECTION),
      ),
    ]);
  const documentsEqual =
    stableStringify(
      baselineDocuments as unknown as JsonValue,
    ) ===
    stableStringify(
      assistedDocuments as unknown as JsonValue,
    );
  const headsEqual =
    stableStringify(
      baselineHead
        ? decodeJson<JsonValue>(
            baselineHead.bytes,
          )
        : null,
    ) ===
    stableStringify(
      assistedHead
        ? decodeJson<JsonValue>(
            assistedHead.bytes,
          )
        : null,
    );
  return {
    region,
    profile,
    indexSet,
    documentsEqual,
    headsEqual,
    equivalent: documentsEqual && headsEqual,
  };
}

function writeParameters(url: URL) {
  const region = requireRegion(
    url.searchParams.get("region"),
  );
  const profile = requireProfile(
    url.searchParams.get("profile"),
  );
  const indexSet = requireIndexSet(
    url.searchParams.get("indexes"),
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
      `${original.body} client-write ${profile} ` +
      `${indexSet} ${iteration}`,
    lastModified: count + iteration,
  };
  return {
    region,
    profile,
    indexSet,
    document,
    public: {
      region,
      profile,
      indexSet,
      indexCount:
        CLIENT_WRITE_INDEX_SETS[indexSet]
          .notes?.length ?? 0,
      iteration,
      id: document.id,
    },
  };
}

function prefixFor(
  parameters: {
    region: string;
    profile: string;
    indexSet: string;
  },
  mode: ClientWriteMode,
) {
  return [
    "client-write",
    parameters.region,
    parameters.profile,
    parameters.indexSet,
    mode,
  ].join("/");
}

async function createRuntime(
  env: Env,
  prefix: string,
  indexSet: ClientWriteIndexSet,
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
  return {
    store,
    counting,
    engine: new ContentAddressedTrieEngine(
      store,
      40,
      sha256Hex,
      false,
      CLIENT_WRITE_INDEX_SETS[indexSet],
    ),
  };
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
    !key.startsWith("client-write/") ||
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
      return json(
        { error: "Result not found" },
        404,
      );
    }
    return new Response(
      await object.arrayBuffer(),
      {
        headers: {
          "cache-control": "no-store",
          "content-type":
            "application/json; charset=utf-8",
        },
      },
    );
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

async function contextSignature(
  env: Env,
  bytes: Uint8Array,
): Promise<string> {
  contextKeyPromise ??= crypto.subtle.importKey(
    "raw",
    bufferView(
      base64ToBytes(env.BENCHMARK_KEY_BASE64),
    ),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const domain = new TextEncoder().encode(
    "thimbledb-client-write-context-v1\0",
  );
  const payload = new Uint8Array(
    domain.byteLength + bytes.byteLength,
  );
  payload.set(domain);
  payload.set(bytes, domain.byteLength);
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await contextKeyPromise,
        bufferView(payload),
      ),
    ),
  );
}

async function sha256Hex(
  bytes: Uint8Array,
): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        bufferView(bytes),
      ),
    ),
  );
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
  if (key.includes("/nodes/")) {
    return "node";
  }
  return "other";
}

function requirePost(request: Request) {
  if (request.method !== "POST") {
    throw new BenchmarkRequestError(
      405,
      "POST required",
    );
  }
}

function requireToken(request: Request, env: Env) {
  if (
    request.headers.get("x-benchmark-token") !==
    env.BENCHMARK_RESULT_TOKEN
  ) {
    throw new BenchmarkRequestError(
      401,
      "Benchmark token is invalid",
    );
  }
}

function requireRegion(
  value: string | null,
): (typeof BENCHMARK_REGIONS)[number] {
  if (
    !value ||
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
): ClientWriteProfile {
  if (
    !value ||
    !(value in BENCHMARK_PROFILES)
  ) {
    throw new BenchmarkRequestError(
      400,
      "Profile is invalid",
    );
  }
  return value as ClientWriteProfile;
}

function requireIndexSet(
  value: string | null,
): ClientWriteIndexSet {
  if (
    !value ||
    !(value in CLIENT_WRITE_INDEX_SETS)
  ) {
    throw new BenchmarkRequestError(
      400,
      "Index set is invalid",
    );
  }
  return value as ClientWriteIndexSet;
}

function requireMode(
  value: string | null,
): ClientWriteMode {
  if (
    !value ||
    !CLIENT_WRITE_MODES.includes(
      value as ClientWriteMode,
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Mode is invalid",
    );
  }
  return value as ClientWriteMode;
}

async function boundedText(
  request: Request,
  maximumBytes: number,
) {
  const declared = Number(
    request.headers.get("content-length"),
  );
  if (
    Number.isFinite(declared) &&
    declared > maximumBytes
  ) {
    throw new BenchmarkRequestError(
      413,
      "Request is too large",
    );
  }
  const text = await request.text();
  if (
    new TextEncoder().encode(text).byteLength >
    maximumBytes
  ) {
    throw new BenchmarkRequestError(
      413,
      "Request is too large",
    );
  }
  return text;
}

function decodeObjectPath(value: string) {
  return value
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function safeName(value: string | null) {
  return value &&
    /^[A-Za-z0-9_-]{1,96}$/.test(value)
    ? value
    : null;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes]
    .map((value) =>
      value.toString(16).padStart(2, "0"),
    )
    .join("");
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
    headers,
  });
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function bufferView(
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(
    new ArrayBuffer(bytes.byteLength),
  );
  copy.set(bytes);
  return copy;
}

class BenchmarkRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkRequestError";
  }
}
