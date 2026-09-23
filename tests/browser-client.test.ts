import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/core.js";
import {
  IndexedDbObjectCache,
  MemoryObjectCache,
  TieredObjectCache,
} from "../src/browser/cache.js";
import { ThimbleClient } from "../src/browser/client.js";
import type {
  JsonObjectReader,
  RemoteJsonObject,
} from "../src/browser/remote-reader.js";
import {
  trieHeadKey,
  trieNodeKey,
  triePathFromHash,
} from "../src/trie-protocol.js";

describe("ThimbleDB browser client", () => {
  it("serves warm content reads from memory and revalidates HEAD", async () => {
    const fixture = trieFixture("products", "product-00001");
    const reader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 0,
      channelName: uniqueName(),
    });

    try {
      expect(await client.get("products", fixture.id)).toEqual(
        fixture.document,
      );
      expect(reader.calls).toBe(4);

      expect(await client.get("products", fixture.id)).toEqual(
        fixture.document,
      );
      expect(reader.calls).toBe(5);
      expect(client.metrics().notModified).toBe(1);
      expect(client.metrics().cache.memoryHits).toBeGreaterThan(0);
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("caches only routing objects under the locations policy", async () => {
    const fixture = trieFixture("products", "product-00002");
    const reader = new FakeReader(fixture.objects);
    const cache = cacheFor("locations", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
    });

    try {
      await client.get("products", fixture.id);
      expect(reader.calls).toBe(4);

      await client.get("products", fixture.id);
      expect(reader.calls).toBe(5);
      expect(client.metrics().cache.memoryHits).toBe(3);
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("restores cached content from IndexedDB after memory is cleared", async () => {
    const fixture = trieFixture("products", "product-00003");
    const reader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
    });

    try {
      await client.get("products", fixture.id);
      expect(reader.calls).toBe(4);

      client.clearMemory();
      await client.get("products", fixture.id);

      expect(reader.calls).toBe(4);
      expect(client.metrics().cache.indexedDbHits).toBe(4);
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("uses a cached HEAD and immutable nodes when revalidation is offline", async () => {
    const fixture = trieFixture("products", "product-00004");
    const reader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 0,
      channelName: uniqueName(),
    });

    try {
      await client.get("products", fixture.id);
      reader.offline = true;

      expect(await client.get("products", fixture.id)).toEqual(
        fixture.document,
      );
      expect(client.metrics().offlineFallbacks).toBe(1);
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("clearing cached objects in one tab does not invalidate another tab's device key", async () => {
    const databaseName = uniqueName();
    const first = cacheFor("content", databaseName);
    const second = cacheFor("content", databaseName);
    const third = cacheFor("content", databaseName);
    const now = Date.now();

    await first.set({
      key: "objects/first",
      etag: "one",
      value: { id: "first" },
      cachedAt: now,
      checkedAt: now,
      immutable: true,
    });
    expect(await second.get("objects/first")).not.toBeNull();

    await first.clearAll();
    await second.set({
      key: "objects/second",
      etag: "two",
      value: { id: "second" },
      cachedAt: now,
      checkedAt: now,
      immutable: true,
    });

    expect(await third.get("objects/second")).toMatchObject({
      value: { id: "second" },
    });
    await third.clearAll();
  });
});

class FakeReader implements JsonObjectReader {
  calls = 0;
  offline = false;

  constructor(
    private readonly objects: Map<
      string,
      { etag: string; value: JsonValue }
    >,
  ) {}

  async get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject> {
    this.calls += 1;
    if (this.offline) {
      throw new Error("offline");
    }
    const object = this.objects.get(key);
    if (!object) {
      return { status: "missing", key };
    }
    if (ifNoneMatch === object.etag) {
      return {
        status: "not-modified",
        key,
        etag: object.etag,
      };
    }
    return {
      status: "found",
      key,
      etag: object.etag,
      value: structuredClone(object.value),
      bytes: Buffer.byteLength(JSON.stringify(object.value)),
    };
  }
}

function cacheFor(
  policy: "content" | "locations",
  databaseName: string,
): TieredObjectCache {
  return new TieredObjectCache(
    new MemoryObjectCache(),
    new IndexedDbObjectCache("test", databaseName),
    policy,
  );
}

function trieFixture(collection: string, id: string) {
  const hash = createHash("sha256").update(id).digest("hex");
  const [first, second] = triePathFromHash(hash);
  const document = {
    id,
    name: "Cached product",
    priceCents: 1_200,
  };
  const head = { revision: 1, rootHash: "root-hash" };
  const root = {
    kind: "root",
    children: { [first]: "branch-hash" },
  };
  const branch = {
    kind: "branch",
    children: { [second]: "leaf-hash" },
  };
  const leaf = {
    kind: "leaf",
    documents: { [id]: document },
  };
  return {
    id,
    document,
    objects: new Map<string, { etag: string; value: JsonValue }>([
      [
        trieHeadKey(collection),
        { etag: "head-etag", value: head },
      ],
      [
        trieNodeKey(collection, "root-hash"),
        { etag: "root-etag", value: root },
      ],
      [
        trieNodeKey(collection, "branch-hash"),
        { etag: "branch-etag", value: branch },
      ],
      [
        trieNodeKey(collection, "leaf-hash"),
        { etag: "leaf-etag", value: leaf },
      ],
    ]),
  };
}

function uniqueName(): string {
  return `thimbledb-test-${crypto.randomUUID()}`;
}
