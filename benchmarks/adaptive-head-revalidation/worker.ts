import type {
  ObjectStore,
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
import { PrefixObjectStore } from "../../src/prefix-store.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../src/cloudflare/r2-object-store.js";
import { scopeStoragePrefix } from "../../src/trie-protocol.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_KEY_ID,
  BENCHMARK_LAYOUTS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  type BenchmarkLayout,
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
        requireBenchmarkToken(request, env);
        return withColo(
          json({
            sourceCommit: env.BENCHMARK_SOURCE_COMMIT,
            harnessCommit: env.BENCHMARK_HARNESS_COMMIT,
            keyBase64: env.BENCHMARK_KEY_BASE64,
            keyId: BENCHMARK_KEY_ID,
            decodedObjectLimit:
              DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
            stableDurationMs: 20_000,
            readIntervalMs: 250,
            mutationTimeoutMs: 25_000,
          }),
          request,
        );
      }
      if (url.pathname === "/prepare") {
        requirePost(request);
        requireBenchmarkToken(request, env);
        return json(await prepareScenario(env, url));
      }
      if (url.pathname === "/mutate") {
        requirePost(request);
        requireBenchmarkToken(request, env);
        return json(await mutateScenario(env, url));
      }
      if (url.pathname.startsWith("/data/")) {
        requireBenchmarkToken(request, env);
        return withColo(
          await serveObject(request, env, url),
          request,
        );
      }
      if (url.pathname === "/regional-result") {
        return regionalResult(request, env, url);
      }
      if (url.pathname === "/cleanup") {
        requirePost(request);
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

async function prepareScenario(
  env: Env,
  url: URL,
) {
  const scenario = requireScenario(
    url.searchParams.get("scenario"),
  );
  const layout = requireLayout(
    url.searchParams.get("layout"),
  );
  const root = new R2ObjectStore(env.BENCHMARK_BUCKET);
  const prefix = scenarioPrefix(scenario);
  const existing = await root.list(prefix);
  await Promise.all(
    existing.map((key) => root.delete(key)),
  );
  const engine = await createEngine(
    env,
    scenario,
    layout,
  );
  await engine.putMany(
    BENCHMARK_COLLECTION,
    [benchmarkDocument(0)],
  );
  return {
    scenario,
    layout,
    version: 0,
    deletedObjects: existing.length,
  };
}

async function mutateScenario(
  env: Env,
  url: URL,
) {
  const scenario = requireScenario(
    url.searchParams.get("scenario"),
  );
  const layout = requireLayout(
    url.searchParams.get("layout"),
  );
  const version = Number(
    url.searchParams.get("version"),
  );
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > 1_000
  ) {
    throw new BenchmarkRequestError(
      400,
      "Mutation version is invalid",
    );
  }
  const engine = await createEngine(
    env,
    scenario,
    layout,
  );
  const document = benchmarkDocument(version);
  await engine.put(
    BENCHMARK_COLLECTION,
    document.id,
    document,
  );
  return { scenario, layout, version };
}

async function serveObject(
  request: Request,
  env: Env,
  url: URL,
) {
  if (request.method !== "GET") {
    throw new BenchmarkRequestError(
      405,
      "Method not allowed",
    );
  }
  const match = /^\/data\/([^/]+)\/(.+)$/.exec(
    url.pathname,
  );
  if (!match) {
    throw new BenchmarkRequestError(
      400,
      "Object path is invalid",
    );
  }
  const scenario = requireScenario(
    decodeURIComponent(match[1]!),
  );
  const relativeKey = decodeObjectPath(match[2]!);
  if (
    !relativeKey.startsWith(
      `scopes/${BENCHMARK_SCOPE_ID}/`,
    ) ||
    relativeKey.includes("..")
  ) {
    throw new BenchmarkRequestError(
      400,
      "Object path is invalid",
    );
  }
  const key = `${scenarioPrefix(scenario)}/${relativeKey}`;
  const object = await env.BENCHMARK_BUCKET.get(key);
  if (!object) {
    return new Response(null, {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "x-benchmark-storage-reads": "1",
      },
    });
  }
  const etag = quoteEtag(object.etag);
  if (
    normaliseEtag(
      request.headers.get("if-none-match"),
    ) === normaliseEtag(etag)
  ) {
    return new Response(null, {
      status: 304,
      headers: {
        "cache-control": "no-store",
        etag,
        "x-benchmark-storage-reads": "1",
      },
    });
  }
  const bytes = await object.arrayBuffer();
  return new Response(bytes, {
    headers: {
      "cache-control": "no-store",
      "content-type":
        "application/vnd.thimbledb.object",
      etag,
      "x-benchmark-storage-reads": "1",
      "x-benchmark-storage-bytes": String(
        bytes.byteLength,
      ),
    },
  });
}

async function createEngine(
  env: Env,
  scenario: string,
  layout: BenchmarkLayout,
) {
  const root = new R2ObjectStore(env.BENCHMARK_BUCKET);
  const scenarioStore = new PrefixObjectStore(
    root,
    scenarioPrefix(scenario),
  );
  const scopePrefix = scopeStoragePrefix(
    BENCHMARK_SCOPE_ID,
  );
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(
      scenarioStore,
      scopePrefix,
    ),
    {
      key: await benchmarkKey(env),
      keyId: BENCHMARK_KEY_ID,
      compression: "gzip",
      objectKeyPrefix: scopePrefix,
    },
  );
  return layout === "snapshot"
    ? new ImmutableSnapshotEngine(store)
    : new ContentAddressedTrieEngine(store);
}

async function regionalResult(
  request: Request,
  env: Env,
  url: URL,
) {
  requireBenchmarkToken(request, env);
  const run = requireScenario(
    url.searchParams.get("run"),
  );
  const region = requireScenario(
    url.searchParams.get("region"),
  );
  const key = `results/${run}/${region}.json`;
  if (request.method === "POST") {
    const declared = Number(
      request.headers.get("content-length") ?? "0",
    );
    if (declared > 5 * 1024 * 1024) {
      throw new BenchmarkRequestError(
        413,
        "Result is too large",
      );
    }
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

function requireBenchmarkToken(
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

function requireScenario(
  value: string | null,
) {
  if (
    !value ||
    !/^[a-z0-9-]{1,80}$/i.test(value)
  ) {
    throw new BenchmarkRequestError(
      400,
      "Scenario name is invalid",
    );
  }
  return value;
}

function requireLayout(
  value: string | null,
): BenchmarkLayout {
  if (
    !BENCHMARK_LAYOUTS.includes(
      value as BenchmarkLayout,
    )
  ) {
    throw new BenchmarkRequestError(
      400,
      "Layout is invalid",
    );
  }
  return value as BenchmarkLayout;
}

function scenarioPrefix(scenario: string) {
  return `scenarios/${scenario}`;
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

function normaliseEtag(etag: string | null) {
  return (etag ?? "")
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "");
}

function quoteEtag(etag: string) {
  return `"${normaliseEtag(etag)}"`;
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

class BenchmarkRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
