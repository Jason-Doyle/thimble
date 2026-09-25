import type {
  JsonDocument,
  JsonPrimitive,
  JsonValue,
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../../../src/core.js";
import {
  base64ToBytes,
  importAesGcmKey,
} from "../../../src/envelope.js";
import { EnvelopeObjectStore } from "../../../src/envelope-store.js";
import {
  ContentAddressedTrieEngine,
} from "../../../src/engines/content-trie.js";
import {
  ImmutableSnapshotEngine,
} from "../../../src/engines/immutable-snapshot.js";
import {
  IndexedSegmentReader,
  type IndexedSegmentPredicate,
  type IndexedSegmentSource,
} from "../../../src/experimental/indexed-segment.js";
import {
  ExperimentalManifestedSegmentEngine,
} from "../../../src/experimental/manifested-segment.js";
import { PrefixObjectStore } from "../../../src/prefix-store.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../../src/cloudflare/r2-object-store.js";
import {
  ownValue,
} from "../../../src/shared-utils.js";

type R2Range =
  | Headers
  | {
      offset?: number;
      length?: number;
      suffix?: number;
    };

type RangeObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
  range?: {
    offset: number;
    length: number;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
};

type BenchmarkBucket = R2BucketBinding & {
  head(key: string): Promise<{
    size: number;
    etag: string;
  } | null>;
  get(
    key: string,
    options?: { range?: R2Range },
  ): Promise<RangeObject | null>;
};

type Env = {
  BENCHMARK_BUCKET: BenchmarkBucket;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  BENCHMARK_KEY_BASE64: string;
  BENCHMARK_KEY_ID: string;
  BENCHMARK_CONTEXT: string;
  BENCHMARK_DOCUMENTS: string;
  BENCHMARK_EXPERIMENTAL_BYTES: string;
};

type KeyMaterial = {
  key: CryptoKey;
  fingerprintKey: CryptoKey;
};

type RunMetrics = {
  documents: number;
  storageReads: number;
  storageBytes: number;
};

let keyMaterialPromise: Promise<KeyMaterial> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/regional-result") {
      return regionalResult(request, env, url);
    }
    if (url.pathname === "/benchmark-config.json") {
      return json(benchmarkConfig(env));
    }

    if (url.pathname === "/run") {
      try {
        return json(
          await runCase(
            request,
            env,
            url.searchParams.get("case") ?? "",
            url.searchParams.get("id"),
          ),
        );
      } catch (error) {
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
    }

    if (url.pathname.startsWith("/data/")) {
      return serveObject(request, env.BENCHMARK_BUCKET);
    }

    const bundleMatch =
      /^\/bundle\/[^/]+\/notes\/([^/]+)$/.exec(
        url.pathname,
      );
    if (request.method === "GET" && bundleMatch?.[1]) {
      const engine = await createTrieEngine(env);
      const bundle = await engine.engine.readBundle(
        "notes",
        decodeURIComponent(bundleMatch[1]),
        {
          maxObjects: 4,
          maxDecodedBytes: 4 * 1024 * 1024,
        },
      );
      return json(bundle);
    }

    return env.ASSETS.fetch(request);
  },
};

async function regionalResult(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const run = safeResultName(url.searchParams.get("run"));
  const region = safeResultName(
    url.searchParams.get("region"),
  );
  if (!run || !region) {
    return json({ error: "Invalid result path" }, 400);
  }
  const key = `results/${run}/${region}.json`;
  if (request.method === "POST") {
    const declared = Number(
      request.headers.get("content-length") ?? "0",
    );
    if (declared > 1024 * 1024) {
      return json({ error: "Result is too large" }, 413);
    }
    const body = await request.text();
    if (body.length > 1024 * 1024) {
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
    const object = (await env.BENCHMARK_BUCKET.get(
      key,
    )) as RangeObject | null;
    if (!object) {
      return json({ error: "Result not found" }, 404);
    }
    return new Response(object.body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function runCase(
  request: Request,
  env: Env,
  caseName: string,
  requestedId: string | null,
): Promise<unknown> {
  const config = benchmarkConfig(env);
  const id = requestedId ?? config.pointIds[0]!;
  const started = performance.now();
  let metrics: RunMetrics;

  if (caseName === "point-experimental") {
    metrics = await experimentalPoint(env, id);
  } else if (caseName === "point-manifested") {
    metrics = await manifestedPoint(env, id);
  } else if (caseName === "point-snapshot") {
    metrics = await oldPoint(env, "snapshot", id);
  } else if (caseName === "point-trie") {
    metrics = await oldPoint(env, "trie", id);
  } else if (caseName === "point-bundle") {
    metrics = await oldBundle(env, id);
  } else if (caseName === "clustered-experimental") {
    metrics = await experimentalQuery(env, {
      field: "category",
      operator: "eq",
      value: config.clusteredCategory,
    });
  } else if (caseName === "clustered-manifested") {
    metrics = await manifestedQuery(env, {
      field: "category",
      operator: "eq",
      value: config.clusteredCategory,
    });
  } else if (caseName === "clustered-snapshot") {
    metrics = await snapshotQuery(env, {
      field: "category",
      operator: "eq",
      value: config.clusteredCategory,
    });
  } else if (caseName === "range-experimental") {
    metrics = await experimentalQuery(env, {
      field: "lastModified",
      operator: "between",
      lower: config.rangeLower,
      upper: config.rangeUpper,
    });
  } else if (caseName === "range-manifested") {
    metrics = await manifestedQuery(env, {
      field: "lastModified",
      operator: "between",
      lower: config.rangeLower,
      upper: config.rangeUpper,
    });
  } else if (caseName === "range-snapshot") {
    metrics = await snapshotQuery(env, {
      field: "lastModified",
      operator: "between",
      lower: config.rangeLower,
      upper: config.rangeUpper,
    });
  } else if (caseName === "distributed-experimental") {
    metrics = await experimentalQuery(env, {
      field: "bucket",
      operator: "eq",
      value: config.distributedBucket,
    });
  } else if (caseName === "distributed-manifested") {
    metrics = await manifestedQuery(env, {
      field: "bucket",
      operator: "eq",
      value: config.distributedBucket,
    });
  } else if (caseName === "distributed-snapshot") {
    metrics = await snapshotQuery(env, {
      field: "bucket",
      operator: "eq",
      value: config.distributedBucket,
    });
  } else if (caseName === "scan-experimental") {
    metrics = await experimentalScan(env);
  } else if (caseName === "scan-manifested") {
    metrics = await manifestedScan(env);
  } else if (caseName === "scan-snapshot") {
    metrics = await snapshotScan(env);
  } else {
    throw new Error(`Unknown benchmark case ${caseName}`);
  }

  async function manifestedPoint(
    env: Env,
    id: string,
  ): Promise<RunMetrics> {
    const runtime = await createManifestedEngine(env);
    const document = await runtime.engine.get("notes", id);
    requireDocument(document, id, "manifested");
    return storeMetrics(runtime.store, 1);
  }

  async function manifestedQuery(
    env: Env,
    predicate: IndexedSegmentPredicate,
  ): Promise<RunMetrics> {
    const runtime = await createManifestedEngine(env);
    const result = await runtime.engine.query(
      "notes",
      predicate,
      Number(env.BENCHMARK_DOCUMENTS),
    );
    return storeMetrics(runtime.store, result.documents.length);
  }

  async function manifestedScan(
    env: Env,
  ): Promise<RunMetrics> {
    const runtime = await createManifestedEngine(env);
    const documents = await runtime.engine.scan("notes");
    requireCount(
      documents.length,
      Number(env.BENCHMARK_DOCUMENTS),
      "manifested scan",
    );
    return storeMetrics(runtime.store, documents.length);
  }

  return {
    case: caseName,
    requestedId: caseName.startsWith("point-") ? id : null,
    colo:
      (
        request as Request & {
          cf?: { colo?: string };
        }
      ).cf?.colo ?? null,
    workerElapsedMs: round(performance.now() - started),
    ...metrics,
  };
}

async function experimentalPoint(
  env: Env,
  id: string,
): Promise<RunMetrics> {
  const { reader, source } = await experimentalReader(env);
  const document = await reader.get(id);
  requireDocument(document, id, "experimental");
  return sourceMetrics(source, 1);
}

async function experimentalQuery(
  env: Env,
  predicate: IndexedSegmentPredicate,
): Promise<RunMetrics> {
  const { reader, source } = await experimentalReader(env);
  const result = await reader.query(predicate);
  return sourceMetrics(source, result.documents.length);
}

async function experimentalScan(
  env: Env,
): Promise<RunMetrics> {
  const { reader, source } = await experimentalReader(env);
  const documents = await reader.scan();
  requireCount(
    documents.length,
    Number(env.BENCHMARK_DOCUMENTS),
    "experimental scan",
  );
  return sourceMetrics(source, documents.length);
}

async function experimentalReader(
  env: Env,
): Promise<{
  reader: IndexedSegmentReader;
  source: R2IndexedSegmentSource;
}> {
  const keys = await getKeyMaterial(env);
  const source = await R2IndexedSegmentSource.open(
    env.BENCHMARK_BUCKET,
    "experimental/notes.tis",
    Number(env.BENCHMARK_EXPERIMENTAL_BYTES),
  );
  return {
    source,
    reader: await IndexedSegmentReader.open(source, {
      cacheBlocks: false,
      security: {
        resolveKey: (keyId) =>
          keyId === env.BENCHMARK_KEY_ID
            ? keys.key
            : null,
        fingerprintKey: keys.fingerprintKey,
        context: env.BENCHMARK_CONTEXT,
      },
    }),
  };
}

async function oldPoint(
  env: Env,
  layout: "snapshot" | "trie",
  id: string,
): Promise<RunMetrics> {
  const runtime =
    layout === "snapshot"
      ? await createSnapshotEngine(env)
      : await createTrieEngine(env);
  const document = await runtime.engine.get("notes", id);
  requireDocument(document, id, layout);
  return storeMetrics(runtime.store, 1);
}

async function oldBundle(
  env: Env,
  id: string,
): Promise<RunMetrics> {
  const runtime = await createTrieEngine(env);
  const bundle = await runtime.engine.readBundle(
    "notes",
    id,
    {
      maxObjects: 4,
      maxDecodedBytes: 4 * 1024 * 1024,
    },
  );
  requireDocument(bundle.document, id, "bundle");
  return storeMetrics(runtime.store, 1);
}

async function snapshotQuery(
  env: Env,
  predicate: IndexedSegmentPredicate,
): Promise<RunMetrics> {
  const runtime = await createSnapshotEngine(env);
  const documents = (await runtime.engine.scan("notes")).filter(
    (document) => documentMatches(document, predicate),
  );
  return storeMetrics(runtime.store, documents.length);
}

async function snapshotScan(env: Env): Promise<RunMetrics> {
  const runtime = await createSnapshotEngine(env);
  const documents = await runtime.engine.scan("notes");
  requireCount(
    documents.length,
    Number(env.BENCHMARK_DOCUMENTS),
    "snapshot scan",
  );
  return storeMetrics(runtime.store, documents.length);
}

async function createSnapshotEngine(env: Env): Promise<{
  engine: ImmutableSnapshotEngine;
  store: CountingObjectStore;
}> {
  const key = (await getKeyMaterial(env)).key;
  const storage = countingEncryptedStore(
    env,
    "snapshot",
    key,
  );
  return {
    store: storage.counting,
    engine: new ImmutableSnapshotEngine(storage.encrypted),
  };
}

async function createTrieEngine(env: Env): Promise<{
  engine: ContentAddressedTrieEngine;
  store: CountingObjectStore;
}> {
  const key = (await getKeyMaterial(env)).key;
  const storage = countingEncryptedStore(
    env,
    "trie",
    key,
  );
  return {
    store: storage.counting,
    engine: new ContentAddressedTrieEngine(
      storage.encrypted,
    ),
  };
}

async function createManifestedEngine(env: Env): Promise<{
  engine: ExperimentalManifestedSegmentEngine;
  store: CountingObjectStore;
}> {
  const key = (await getKeyMaterial(env)).key;
  const storage = countingEncryptedStore(
    env,
    "manifested",
    key,
  );
  return {
    store: storage.counting,
    engine: new ExperimentalManifestedSegmentEngine(
      storage.encrypted,
      {
        targetBlockBytes: 256 * 1024,
        collectionFields: {
          notes: [
            { field: "category", mode: "equality" },
            { field: "bucket", mode: "equality" },
            { field: "lastModified", mode: "range" },
          ],
        },
      },
    ),
  };
}

function countingEncryptedStore(
  env: Env,
  prefix: string,
  key: CryptoKey,
): {
  counting: CountingObjectStore;
  encrypted: EnvelopeObjectStore;
} {
  const counting = new CountingObjectStore(
    new PrefixObjectStore(
        new R2ObjectStore(
          env.BENCHMARK_BUCKET as unknown as R2BucketBinding,
        ),
        prefix,
    ),
  );
  return {
    counting,
    encrypted: new EnvelopeObjectStore(counting, {
      key,
      keyId: env.BENCHMARK_KEY_ID,
    }),
  };
}

async function getKeyMaterial(env: Env): Promise<KeyMaterial> {
  keyMaterialPromise ??= (async () => {
    const raw = base64ToBytes(env.BENCHMARK_KEY_BASE64);
    const fingerprintRaw = new Uint8Array(
      new ArrayBuffer(raw.byteLength),
    );
    fingerprintRaw.set(raw);
    return {
      key: await importAesGcmKey(raw, ["decrypt"]),
      fingerprintKey: await crypto.subtle.importKey(
        "raw",
        fingerprintRaw,
        {
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["sign"],
      ),
    };
  })();
  return keyMaterialPromise;
}

function benchmarkConfig(env: Env) {
  const documents = Number(env.BENCHMARK_DOCUMENTS);
  return {
    documents,
    keyBase64: env.BENCHMARK_KEY_BASE64,
    keyId: env.BENCHMARK_KEY_ID,
    context: env.BENCHMARK_CONTEXT,
    pointIds: Array.from(
      { length: 100 },
      (_, index) =>
        `note-${String(
          (index * 977) % documents,
        ).padStart(6, "0")}`,
    ),
    clusteredCategory: "rare",
    distributedBucket: "bucket-07",
    rangeLower: Math.floor(documents * 0.7),
    rangeUpper: Math.floor(documents * 0.7) + 24,
  };
}

async function serveObject(
  request: Request,
  bucket: BenchmarkBucket,
): Promise<Response> {
  const url = new URL(request.url);
  const key = decodeURIComponent(
    url.pathname.slice("/data/".length),
  );
  if (!key || key.includes("..")) {
    return new Response("Invalid object key", { status: 400 });
  }
  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, {
      status: 200,
      headers: objectHeaders(object.size, object.etag),
    });
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
    });
  }
  const rangeRequested = request.headers.has("range");
  const object = await bucket.get(
    key,
    rangeRequested
      ? { range: request.headers }
      : undefined,
  );
  if (!object) {
    return new Response(null, { status: 404 });
  }
  const headers = objectHeaders(object.size, object.etag);
  let status = 200;
  if (rangeRequested && object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set(
      "content-range",
      `bytes ${start}-${end}/${object.size}`,
    );
    headers.set(
      "content-length",
      String(object.range.length),
    );
    status = 206;
  }
  return new Response(object.body, { status, headers });
}

class R2IndexedSegmentSource
implements IndexedSegmentSource {
  reads = 0;
  bytesRead = 0;

  private constructor(
    private readonly bucket: BenchmarkBucket,
    private readonly key: string,
    readonly byteLength: number,
    private readonly prefetchedOffset: number,
    private readonly prefetchedBytes: Uint8Array,
  ) {}

  static async open(
    bucket: BenchmarkBucket,
    key: string,
    byteLength: number,
  ): Promise<R2IndexedSegmentSource> {
    const suffix = Math.min(64 * 1024, byteLength);
    const object = await bucket.get(key, {
      range: { suffix },
    });
    if (!object) {
      throw new Error("Experimental segment is missing");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== suffix) {
      throw new Error(
        "Experimental suffix range length is invalid",
      );
    }
    const source = new R2IndexedSegmentSource(
      bucket,
      key,
      byteLength,
      byteLength - suffix,
      bytes,
    );
    source.reads = 1;
    source.bytesRead = bytes.byteLength;
    return source;
  }

  async read(
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      offset >= this.prefetchedOffset &&
      offset + length <=
        this.prefetchedOffset + this.prefetchedBytes.byteLength
    ) {
      const start = offset - this.prefetchedOffset;
      return this.prefetchedBytes.slice(start, start + length);
    }
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
    });
    if (!object) {
      throw new Error("Experimental range is missing");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== length) {
      throw new Error(
        "Experimental range length is invalid",
      );
    }
    this.reads += 1;
    this.bytesRead += bytes.byteLength;
    return bytes;
  }

}

class CountingObjectStore implements ObjectStore {
  reads = 0;
  bytesRead = 0;

  constructor(private readonly delegate: ObjectStore) {}

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.delegate.get(key);
    this.reads += 1;
    this.bytesRead += object?.bytes.byteLength ?? 0;
    return object;
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    return this.delegate.put(key, bytes, conditions);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.delegate.list(prefix);
  }
}

function sourceMetrics(
  source: R2IndexedSegmentSource,
  documents: number,
): RunMetrics {
  return {
    documents,
    storageReads: source.reads,
    storageBytes: source.bytesRead,
  };
}

function storeMetrics(
  store: CountingObjectStore,
  documents: number,
): RunMetrics {
  return {
    documents,
    storageReads: store.reads,
    storageBytes: store.bytesRead,
  };
}

function objectHeaders(size: number, etag: string): Headers {
  return new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(size),
    "content-type": "application/octet-stream",
    etag: quoteEtag(etag),
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

function requireDocument(
  document: JsonDocument | null,
  id: string,
  label: string,
): void {
  if (!document || document.id !== id) {
    throw new Error(`${label} missed ${id}`);
  }
}

function requireCount(
  actual: number,
  expected: number,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${label} returned ${actual}; expected ${expected}`,
    );
  }
}

function quoteEtag(etag: string): string {
  const raw = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  return `"${raw}"`;
}

function safeResultName(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,80}$/.test(value)
    ? value
    : null;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
