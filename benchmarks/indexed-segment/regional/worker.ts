import {
  base64ToBytes,
  importAesGcmKey,
} from "../../../src/envelope.js";
import { EnvelopeObjectStore } from "../../../src/envelope-store.js";
import {
  ContentAddressedTrieEngine,
} from "../../../src/engines/content-trie.js";
import { PrefixObjectStore } from "../../../src/prefix-store.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../../../src/cloudflare/r2-object-store.js";

type RangeObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
  range?: {
    offset: number;
    length: number;
  };
};

type BenchmarkBucket = R2BucketBinding & {
  head(key: string): Promise<{
    size: number;
    etag: string;
  } | null>;
  get(
    key: string,
    options?: { range?: Headers },
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
};

let bundleEngine:
  | Promise<ContentAddressedTrieEngine>
  | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/benchmark-config.json") {
      return json({
        documents: Number(env.BENCHMARK_DOCUMENTS),
        keyBase64: env.BENCHMARK_KEY_BASE64,
        keyId: env.BENCHMARK_KEY_ID,
        context: env.BENCHMARK_CONTEXT,
        pointIds: Array.from(
          { length: 100 },
          (_, index) =>
            `note-${String(
              (index * 977) %
                Number(env.BENCHMARK_DOCUMENTS),
            ).padStart(6, "0")}`,
        ),
        clusteredCategory: "rare",
        distributedBucket: "bucket-07",
        rangeLower: Math.floor(
          Number(env.BENCHMARK_DOCUMENTS) * 0.7,
        ),
        rangeUpper:
          Math.floor(
            Number(env.BENCHMARK_DOCUMENTS) * 0.7,
          ) + 24,
      });
    }

    if (url.pathname.startsWith("/data/")) {
      return serveObject(request, env.BENCHMARK_BUCKET);
    }

    const bundleMatch =
      /^\/bundle\/[^/]+\/notes\/([^/]+)$/.exec(
        url.pathname,
      );
    if (request.method === "GET" && bundleMatch?.[1]) {
      const engine = await getBundleEngine(env);
      const bundle = await engine.readBundle(
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
      headers: objectHeaders(
        object.size,
        object.etag,
      ),
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

function objectHeaders(
  size: number,
  etag: string,
): Headers {
  return new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(size),
    "content-type": "application/octet-stream",
    etag: quoteEtag(etag),
  });
}

async function getBundleEngine(
  env: Env,
): Promise<ContentAddressedTrieEngine> {
  bundleEngine ??= (async () => {
    const key = await importAesGcmKey(
      base64ToBytes(env.BENCHMARK_KEY_BASE64),
      ["decrypt"],
    );
    const root = new PrefixObjectStore(
      new R2ObjectStore(
        env.BENCHMARK_BUCKET as unknown as R2BucketBinding,
      ),
      "trie",
    );
    return new ContentAddressedTrieEngine(
      new EnvelopeObjectStore(root, {
        key,
        keyId: env.BENCHMARK_KEY_ID,
      }),
    );
  })();
  return bundleEngine;
}

function quoteEtag(etag: string): string {
  const raw = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  return `"${raw}"`;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
