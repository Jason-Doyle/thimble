import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../core.js";

export const EXPERIMENTAL_EDGE_CACHE_TTL_SECONDS = 3_600;

export type ExperimentalEdgeCacheMetrics = {
  hits: number;
  hitBytes: number;
  misses: number;
  bypasses: number;
};

export type ExperimentalResponseCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
};

export class ExperimentalImmutableObjectEdgeCacheStore
implements ObjectStore {
  readonly metrics: ExperimentalEdgeCacheMetrics = {
    hits: 0,
    hitBytes: 0,
    misses: 0,
    bypasses: 0,
  };

  constructor(
    private readonly delegate: ObjectStore,
    private readonly options: {
      cache: ExperimentalResponseCache;
      origin: string;
      cacheNamespace: string;
      storageNamespace: string;
      ttlSeconds?: number;
      defer?: (promise: Promise<void>) => void;
    },
  ) {
    validateNamespace(
      options.cacheNamespace,
      "cache namespace",
    );
    validateNamespace(
      options.storageNamespace,
      "storage namespace",
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    if (!isExperimentalImmutableObjectKey(key)) {
      this.metrics.bypasses += 1;
      return this.delegate.get(key);
    }

    const cacheKey = experimentalEdgeCacheRequest(
      this.options.origin,
      this.options.cacheNamespace,
      this.options.storageNamespace,
      key,
    );
    const cached = await this.options.cache.match(cacheKey);
    if (cached) {
      if (cached.status !== 200) {
        await this.options.cache.delete(cacheKey);
        throw new Error(
          `Experimental edge cache returned status ${cached.status}`,
        );
      }
      const etag = cached.headers.get("etag");
      if (!etag) {
        await this.options.cache.delete(cacheKey);
        throw new Error(
          "Experimental edge cache entry is missing an ETag",
        );
      }
      const bytes = new Uint8Array(
        await cached.arrayBuffer(),
      );
      this.metrics.hits += 1;
      this.metrics.hitBytes += bytes.byteLength;
      return { bytes, etag };
    }

    this.metrics.misses += 1;
    const object = await this.delegate.get(key);
    if (!object) {
      return null;
    }
    const response = new Response(object.bytes.slice(), {
      headers: {
        "cache-control":
          `public, max-age=${this.options.ttlSeconds ?? EXPERIMENTAL_EDGE_CACHE_TTL_SECONDS}`,
        "content-type": "application/octet-stream",
        etag: object.etag,
      },
    });
    const write = this.options.cache.put(
      cacheKey,
      response,
    );
    if (this.options.defer) {
      this.options.defer(write);
    } else {
      await write;
    }
    return object;
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
    await this.evict(key);
    return result;
  }

  async delete(key: string): Promise<void> {
    await this.delegate.delete(key);
    await this.evict(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.delegate.list(prefix);
  }

  private async evict(key: string): Promise<void> {
    if (!isExperimentalImmutableObjectKey(key)) {
      return;
    }
    await this.options.cache.delete(
      experimentalEdgeCacheRequest(
        this.options.origin,
        this.options.cacheNamespace,
        this.options.storageNamespace,
        key,
      ),
    );
  }
}

export function isExperimentalImmutableObjectKey(
  key: string,
): boolean {
  const segments = key.split("/");
  if (
    segments.length < 6 ||
    segments[0] !== "scopes" ||
    !segments[1] ||
    !segments[3]
  ) {
    return false;
  }
  const layout = segments[2];
  const family = segments[4];
  const hash = segments.at(-1);
  if (!hash || !/^[0-9a-f]{64}\.json$/.test(hash)) {
    return false;
  }
  if (
    layout === "content-snapshot" &&
    family === "snapshots" &&
    segments.length === 6
  ) {
    return true;
  }
  if (
    layout === "content-trie" &&
    family === "nodes" &&
    segments.length === 6
  ) {
    return true;
  }
  return (
    (layout === "content-snapshot" ||
      layout === "content-trie") &&
    family === "indexes" &&
    segments.length === 7 &&
    Boolean(segments[5])
  );
}

export function experimentalEdgeCacheRequest(
  origin: string,
  cacheNamespace: string,
  storageNamespace: string,
  key: string,
): Request {
  validateNamespace(cacheNamespace, "cache namespace");
  validateNamespace(storageNamespace, "storage namespace");
  const url = new URL(
    "/__thimble-experimental-immutable-object-cache",
    origin,
  );
  url.searchParams.set("cache", cacheNamespace);
  url.searchParams.set("storage", storageNamespace);
  url.searchParams.set("key", key);
  return new Request(url, { method: "GET" });
}

function validateNamespace(
  value: string,
  label: string,
): void {
  if (!/^[a-z0-9._/-]{1,160}$/i.test(value)) {
    throw new Error(
      `Experimental edge cache ${label} is invalid`,
    );
  }
}
