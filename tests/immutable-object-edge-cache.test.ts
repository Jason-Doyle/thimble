import { describe, expect, it } from "vitest";
import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../src/core.js";
import {
  ExperimentalImmutableObjectEdgeCacheStore,
  experimentalEdgeCacheRequest,
  isExperimentalImmutableObjectKey,
  type ExperimentalResponseCache,
} from "../src/experimental/immutable-object-edge-cache.js";

const immutableSnapshotKey =
  "scopes/public/content-snapshot/notes/snapshots/" +
  `${"a".repeat(64)}.json`;
const immutableTrieKey =
  "scopes/public/content-trie/notes/nodes/" +
  `${"b".repeat(64)}.json`;
const immutableIndexKey =
  "scopes/public/content-trie/notes/indexes/by-category/" +
  `${"c".repeat(64)}.json`;
const mutableHeadKey =
  "scopes/public/content-trie/notes/HEAD.json";

describe("experimental immutable object edge cache", () => {
  it("recognises only content-addressed data objects", () => {
    expect(
      isExperimentalImmutableObjectKey(immutableSnapshotKey),
    ).toBe(true);
    expect(
      isExperimentalImmutableObjectKey(immutableTrieKey),
    ).toBe(true);
    expect(
      isExperimentalImmutableObjectKey(immutableIndexKey),
    ).toBe(true);
    expect(
      isExperimentalImmutableObjectKey(mutableHeadKey),
    ).toBe(false);
    expect(
      isExperimentalImmutableObjectKey(
        "scopes/public/content-trie/notes/nodes/not-a-hash.json",
      ),
    ).toBe(false);
  });

  it("serves a second immutable read without touching storage", async () => {
    const delegate = new MemoryStore();
    const cache = new MemoryResponseCache();
    await delegate.put(
      immutableTrieKey,
      new Uint8Array([1, 2, 3]),
    );
    const store = createStore(delegate, cache);

    await expect(store.get(immutableTrieKey)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      etag: '"1"',
    });
    await expect(store.get(immutableTrieKey)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      etag: '"1"',
    });

    expect(delegate.reads).toBe(1);
    expect(store.metrics).toEqual({
      hits: 1,
      hitBytes: 3,
      misses: 1,
      bypasses: 0,
    });
  });

  it("always reads mutable HEAD objects from storage", async () => {
    const delegate = new MemoryStore();
    const cache = new MemoryResponseCache();
    await delegate.put(
      mutableHeadKey,
      new Uint8Array([4, 5]),
    );
    const store = createStore(delegate, cache);

    await store.get(mutableHeadKey);
    await store.get(mutableHeadKey);

    expect(delegate.reads).toBe(2);
    expect(cache.entries.size).toBe(0);
    expect(store.metrics).toEqual({
      hits: 0,
      hitBytes: 0,
      misses: 0,
      bypasses: 2,
    });
  });

  it("evicts an immutable entry after a write", async () => {
    const delegate = new MemoryStore();
    const cache = new MemoryResponseCache();
    await delegate.put(
      immutableSnapshotKey,
      new Uint8Array([1]),
    );
    const store = createStore(delegate, cache);
    await store.get(immutableSnapshotKey);

    await store.put(
      immutableSnapshotKey,
      new Uint8Array([2]),
    );
    await expect(
      store.get(immutableSnapshotKey),
    ).resolves.toEqual({
      bytes: new Uint8Array([2]),
      etag: '"2"',
    });
    expect(delegate.reads).toBe(2);
  });

  it("rejects a malformed cached response", async () => {
    const delegate = new MemoryStore();
    const cache = new MemoryResponseCache();
    const request = experimentalEdgeCacheRequest(
      "https://example.com",
      "test",
      "read/large/trie",
      immutableTrieKey,
    );
    cache.entries.set(
      request.url,
      new Response(new Uint8Array([1])),
    );
    const store = createStore(delegate, cache);

    await expect(
      store.get(immutableTrieKey),
    ).rejects.toThrow("missing an ETag");
    expect(cache.entries.has(request.url)).toBe(false);
  });
});

function createStore(
  delegate: ObjectStore,
  cache: ExperimentalResponseCache,
) {
  return new ExperimentalImmutableObjectEdgeCacheStore(
    delegate,
    {
      cache,
      origin: "https://example.com",
      cacheNamespace: "test",
      storageNamespace: "read/large/trie",
    },
  );
}

class MemoryResponseCache
implements ExperimentalResponseCache {
  readonly entries = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(
    request: Request,
    response: Response,
  ): Promise<void> {
    this.entries.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  reads = 0;
  etag = 0;

  get(key: string): Promise<StoredObject | null> {
    this.reads += 1;
    const object = this.objects.get(key);
    return Promise.resolve(
      object
        ? {
            bytes: object.bytes.slice(),
            etag: object.etag,
          }
        : null,
    );
  }

  put(
    key: string,
    bytes: Uint8Array,
    _conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    const etag = `"${++this.etag}"`;
    this.objects.set(key, {
      bytes: bytes.slice(),
      etag,
    });
    return Promise.resolve({ etag });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(),
    );
  }
}
