import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/core.js";
import {
  IndexedDbObjectCache,
  MemoryObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "../src/browser/cache.js";
import { ThimbleClient } from "../src/browser/client.js";
import type {
  JsonObjectReader,
  PointReadBundleReader,
  RemoteJsonObject,
} from "../src/browser/remote-reader.js";
import { HttpObjectReadError } from "../src/browser/remote-reader.js";
import {
  snapshotHeadKey,
  snapshotPageKey,
} from "../src/snapshot-protocol.js";
import {
  trieHeadKey,
  trieNodeKey,
  triePathFromHash,
} from "../src/trie-protocol.js";

describe("ThimbleDB browser client", () => {
  it("uses one cold read bundle and reuses its cached objects", async () => {
    const fixture = trieFixture("products", "product-bundle");
    const bundleReader = new FakeBundleReader({
      status: "found",
      bytes: 512,
      bundle: {
        collection: "products",
        id: fixture.id,
        revision: 1,
        document: fixture.document,
        objects: [...fixture.objects].map(([key, object]) => ({
          key,
          etag: object.etag,
          value: structuredClone(object.value),
        })),
        layout: "trie",
      },
    });
    const objectReader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader: objectReader,
      bundleReader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
    });

    await expect(
      client.get("products", fixture.id),
    ).resolves.toEqual(fixture.document);
    await expect(
      client.get("products", fixture.id),
    ).resolves.toEqual(fixture.document);

    expect(bundleReader.calls).toBe(1);
    expect(objectReader.calls).toBe(0);
    expect(client.metrics()).toMatchObject({
      remoteReads: 1,
      remoteBytes: 512,
      bundleReads: 1,
      bundleBytes: 512,
      bundleFallbacks: 0,
    });
  });

  it("falls back to individual objects when a bundle is unavailable", async () => {
    const fixture = trieFixture("products", "product-fallback");
    const bundleReader = new FakeBundleReader({
      status: "fallback",
    });
    const objectReader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader: objectReader,
      bundleReader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
    });

    await expect(
      client.get("products", fixture.id),
    ).resolves.toEqual(fixture.document);

    expect(bundleReader.calls).toBe(1);
    expect(objectReader.calls).toBe(4);
    expect(client.metrics()).toMatchObject({
      remoteReads: 5,
      bundleReads: 1,
      bundleFallbacks: 1,
    });
  });

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

  it("reads immutable snapshot collections through the same cache", async () => {
    const collection = "settings";
    const headKey = snapshotHeadKey(collection);
    const pageKey = snapshotPageKey(collection, "snapshot-one");
    const reader = new FakeReader(
      new Map([
        [
          headKey,
          {
            etag: "head",
            value: {
              revision: 1,
              snapshotHash: "snapshot-one",
            },
          },
        ],
        [
          pageKey,
          {
            etag: "page",
            value: {
              documents: {
                one: { id: "one", value: "snapshot" },
              },
            },
          },
        ],
      ]),
    );
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
      collectionLayouts: { settings: "snapshot" },
    });

    try {
      await expect(
        client.get(collection, "one"),
      ).resolves.toMatchObject({ value: "snapshot" });
      await expect(client.scan(collection)).resolves.toHaveLength(1);
      expect(reader.calls).toBe(2);
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("rejects oversized snapshot scans from HEAD metadata before page fetch", async () => {
    const collection = "settings";
    const reader = new FakeReader(
      new Map([
        [
          snapshotHeadKey(collection),
          {
            etag: "head",
            value: {
              revision: 1,
              snapshotHash: "snapshot-large",
              records: 2,
              tombstones: 0,
              decodedBytes: 100,
            },
          },
        ],
        [
          snapshotPageKey(collection, "snapshot-large"),
          {
            etag: "page",
            value: {
              documents: {
                one: { id: "one" },
                two: { id: "two" },
              },
            },
          },
        ],
      ]),
    );
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
      collectionLayouts: { settings: "snapshot" },
    });

    try {
      await expect(
        client.collection("settings").query({
          version: 1,
          maxScanDocuments: 1,
        }),
      ).rejects.toThrow("above the configured maximum");
      expect(reader.calls).toBe(1);
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("validates snapshot tombstone metadata before bounded queries", async () => {
    const collection = "settings";
    const page = {
      documents: {
        one: { id: "one", value: "visible" },
        two: {
          id: "two",
          __thimbleTombstone: {
            deletedAt: "2026-09-24T00:00:00.000Z",
            restoreUntil: "2026-10-24T00:00:00.000Z",
            purgeAfter: "2026-10-31T00:00:00.000Z",
          },
          document: { id: "two", value: "deleted" },
        },
      },
    };
    const reader = new FakeReader(
      new Map([
        [
          snapshotHeadKey(collection),
          {
            etag: "head",
            value: {
              revision: 2,
              snapshotHash: "snapshot-deleted",
              records: 2,
              tombstones: 1,
              decodedBytes: Buffer.byteLength(
                JSON.stringify(page),
              ),
            },
          },
        ],
        [
          snapshotPageKey(collection, "snapshot-deleted"),
          {
            etag: "page",
            value: page,
          },
        ],
      ]),
    );
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
      collectionLayouts: { settings: "snapshot" },
    });

    try {
      await expect(
        client.collection("settings").query({
          version: 1,
          maxScanDocuments: 1,
        }),
      ).resolves.toMatchObject({
        documents: [{ id: "one", value: "visible" }],
        scannedDocuments: 1,
      });
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it.each([
    [
      "stored records",
      {
        records: 1_001,
        tombstones: 1_000,
        decodedBytes: 100,
        maximum: 1,
      },
    ],
    [
      "tombstones",
      {
        records: 1_002,
        tombstones: 1_001,
        decodedBytes: 100,
        maximum: 2_000,
      },
    ],
    [
      "decoded bytes",
      {
        records: 1,
        tombstones: 0,
        decodedBytes: 16 * 1024 * 1024 + 1,
        maximum: 1,
      },
    ],
  ])(
    "rejects snapshot %s bounds before page fetch",
    async (_label, metadata) => {
      const collection = "settings";
      const reader = new FakeReader(
        new Map([
          [
            snapshotHeadKey(collection),
            {
              etag: "head",
              value: {
                revision: 1,
                snapshotHash: "snapshot-oversized",
                records: metadata.records,
                tombstones: metadata.tombstones,
                decodedBytes: metadata.decodedBytes,
              },
            },
          ],
          [
            snapshotPageKey(collection, "snapshot-oversized"),
            {
              etag: "page",
              value: {
                documents: {
                  one: { id: "one" },
                },
              },
            },
          ],
        ]),
      );
      const cache = cacheFor("content", uniqueName());
      const client = new ThimbleClient({
        reader,
        cache,
        headTtlMs: 10_000,
        channelName: uniqueName(),
        collectionLayouts: { settings: "snapshot" },
      });

      try {
        await expect(
          client.collection("settings").query({
            version: 1,
            maxScanDocuments: metadata.maximum,
          }),
        ).rejects.toThrow(
          "stored-record, tombstone, or byte limits",
        );
        expect(reader.calls).toBe(1);
      } finally {
        client.close();
        await cache.clearAll();
      }
    },
  );

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

  it("does not use offline fallback after authorization rejection", async () => {
    const firstFixture = trieFixture("products", "product-auth");
    const secondFixture = trieFixture("customers", "customer-auth");
    const reader = new FakeReader(
      new Map([
        ...firstFixture.objects,
        ...secondFixture.objects,
      ]),
    );
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 0,
      channelName: uniqueName(),
    });

    try {
      await client.get("products", firstFixture.id);
      await client.get("customers", secondFixture.id);
      reader.error = new HttpObjectReadError(
        401,
        trieHeadKey("products"),
      );

      await expect(
        client.get("products", firstFixture.id),
      ).rejects.toMatchObject({
        status: 401,
      });
      expect(client.metrics().offlineFallbacks).toBe(0);
      await expect(
        client.get("customers", secondFixture.id),
      ).rejects.toThrow("logged out");
    } finally {
      client.close();
      await cache.clearAll();
    }
  });

  it("broadcasts logout across scope-specific clients", async () => {
    const sessionChannelName = uniqueName();
    const first = new ThimbleClient({
      reader: new FakeReader(new Map()),
      cache: cacheFor("content", uniqueName()),
      headTtlMs: 0,
      scopeId: "user:first",
      channelName: uniqueName(),
      sessionChannelName,
    });
    const second = new ThimbleClient({
      reader: new FakeReader(new Map()),
      cache: cacheFor("content", uniqueName()),
      headTtlMs: 0,
      scopeId: "tenant:second",
      channelName: uniqueName(),
      sessionChannelName,
    });

    await first.logout();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      second.get("products", "one"),
    ).rejects.toThrow("logged out");
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

  it("uses one persisted device key during concurrent first use without Web Locks", async () => {
    const databaseName = uniqueName();
    const first = cacheFor("content", databaseName);
    const second = cacheFor("content", databaseName);
    const now = Date.now();
    await Promise.all([
      first.set({
        key: "objects/one",
        etag: "one",
        value: { id: "one" },
        cachedAt: now,
        checkedAt: now,
        immutable: true,
      }),
      second.set({
        key: "objects/two",
        etag: "two",
        value: { id: "two" },
        cachedAt: now,
        checkedAt: now,
        immutable: true,
      }),
    ]);

    const fresh = cacheFor("content", databaseName);
    expect(await fresh.get("objects/one")).toMatchObject({
      value: { id: "one" },
    });
    expect(await fresh.get("objects/two")).toMatchObject({
      value: { id: "two" },
    });
    await fresh.clearAll();
  });

  it("destroys cached scope data and blocks reads after logout", async () => {
    const fixture = trieFixture("products", "product-00005");
    const reader = new FakeReader(fixture.objects);
    const databaseName = uniqueName();
    const cache = cacheFor("content", databaseName);
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      scopeId: "user:test",
      channelName: uniqueName(),
    });

    await client.get("products", fixture.id);
    await client.logout();

    await expect(
      client.get("products", fixture.id),
    ).rejects.toThrow("logged out");
    const fresh = cacheFor("content", databaseName);
    expect(
      await fresh.get(trieHeadKey("products")),
    ).toBeNull();
    await fresh.clearAll();
  });

  it("destroys dormant legacy cache namespaces for one authority", async () => {
    const databaseName = uniqueName();
    const authority =
      "local:https://authority.example.test:/api/objects";
    const legacy = new IndexedDbObjectCache(
      `${authority}:user:legacy`,
      databaseName,
    );
    const other = new IndexedDbObjectCache(
      "local:https://other.example.test:/api/objects:user:other",
      databaseName,
    );
    const now = Date.now();
    await legacy.set({
      key: "content-snapshot/notes/HEAD.json",
      etag: "legacy",
      value: { revision: 1, snapshotHash: null },
      cachedAt: now,
      checkedAt: now,
      immutable: false,
    });
    await other.set({
      key: "content-snapshot/notes/HEAD.json",
      etag: "other",
      value: { revision: 1, snapshotHash: null },
      cachedAt: now,
      checkedAt: now,
      immutable: false,
    });

    await IndexedDbObjectCache.destroyNamespaces(
      `${authority}:`,
      databaseName,
    );

    await expect(
      new IndexedDbObjectCache(
        `${authority}:user:legacy`,
        databaseName,
      ).get("content-snapshot/notes/HEAD.json"),
    ).resolves.toBeNull();
    await expect(
      new IndexedDbObjectCache(
        "local:https://other.example.test:/api/objects:user:other",
        databaseName,
      ).get("content-snapshot/notes/HEAD.json"),
    ).resolves.toMatchObject({
      etag: "other",
    });
    await other.destroy();
  });

  it("keeps read access after a denied write", async () => {
    const fixture = trieFixture("products", "product-read-only");
    const cache = cacheFor("content", uniqueName());
    let authorityCleanup = 0;
    const client = new ThimbleClient({
      reader: new FakeReader(fixture.objects),
      cache,
      headTtlMs: 10_000,
      scopeId: "tenant:read-only",
      channelName: uniqueName(),
      fetchImplementation: (async () =>
        Response.json(
          {
            error: "scope_denied",
            message: "Access was denied",
          },
          { status: 403 },
        )) as typeof fetch,
      onAuthorityLogout: () => {
        authorityCleanup += 1;
      },
    });

    await expect(
      client.get("products", fixture.id),
    ).resolves.toEqual(fixture.document);
    await expect(
      client.write("products", fixture.id, fixture.document),
    ).rejects.toThrow("Write failed with 403");
    await expect(
      client.get("products", fixture.id),
    ).resolves.toEqual(fixture.document);
    expect(authorityCleanup).toBe(0);

    await client.logout();
    expect(authorityCleanup).toBe(1);
  });

  it("still performs authority cleanup after a scope read denial", async () => {
    const fixture = trieFixture("products", "product-revoked");
    const reader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    let authorityCleanup = 0;
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 0,
      scopeId: "tenant:revoked",
      channelName: uniqueName(),
      sessionChannelName: uniqueName(),
      onAuthorityLogout: () => {
        authorityCleanup += 1;
      },
    });

    await client.get("products", fixture.id);
    reader.error = new HttpObjectReadError(
      403,
      trieHeadKey("products"),
    );
    await expect(
      client.get("products", fixture.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(authorityCleanup).toBe(0);

    await client.logout();
    expect(authorityCleanup).toBe(1);
  });

  it("does not roll cached HEAD backwards when bundles arrive out of order", async () => {
    const cache = cacheFor("content", uniqueName());
    const client = new ThimbleClient({
      reader: new FakeReader(new Map()),
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
    });
    const headKey = trieHeadKey("products");

    await client.applyBundle({
      collection: "products",
      id: "one",
      revision: 2,
      document: null,
      objects: [
        {
          key: headKey,
          etag: "two",
          value: { revision: 2, rootHash: "root-two" },
        },
      ],
    });
    await client.applyBundle({
      collection: "products",
      id: "one",
      revision: 1,
      document: null,
      objects: [
        {
          key: headKey,
          etag: "one",
          value: { revision: 1, rootHash: "root-one" },
        },
      ],
    });

    expect(await cache.get(headKey)).toMatchObject({
      value: { revision: 2, rootHash: "root-two" },
    });
    client.close();
    await cache.clearAll();
  });

  it("does not repopulate cache when a write finishes after logout", async () => {
    const cache = cacheFor("content", uniqueName());
    let resolveFetch:
      | ((response: Response) => void)
      | undefined;
    const delayedFetch = () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    const client = new ThimbleClient({
      reader: new FakeReader(new Map()),
      cache,
      headTtlMs: 10_000,
      scopeId: "user:test",
      channelName: uniqueName(),
      fetchImplementation: delayedFetch as typeof fetch,
    });
    const write = client.write("products", "one", {
      id: "one",
      value: "late",
    });
    const rejection = expect(write).rejects.toThrow("logged out");
    await client.logout();
    resolveFetch?.(
      new Response(
        JSON.stringify({
          collection: "products",
          id: "one",
          revision: 1,
          document: { id: "one", value: "late" },
          objects: [
            {
              key: trieHeadKey("products"),
              etag: "one",
              value: { revision: 1, rootHash: "root" },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await rejection;
    expect(await cache.get(trieHeadKey("products"))).toBeNull();
  });

  it("does not return or cache a delayed read after logout", async () => {
    const fixture = trieFixture("products", "product-00006");
    let resolveRead:
      | ((value: RemoteJsonObject) => void)
      | undefined;
    const reader: JsonObjectReader = {
      get: async () =>
        new Promise<RemoteJsonObject>((resolve) => {
          resolveRead = resolve;
        }),
    };
    const databaseName = uniqueName();
    const cache = cacheFor("content", databaseName);
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 0,
      scopeId: "user:test",
      channelName: uniqueName(),
    });

    const read = client.get("products", fixture.id);
    const rejection = expect(read).rejects.toThrow("logged out");
    await client.logout();
    const head = fixture.objects.get(trieHeadKey("products"))!;
    resolveRead?.({
      status: "found",
      key: trieHeadKey("products"),
      etag: head.etag,
      value: structuredClone(head.value),
      bytes: 32,
    });

    await rejection;
    const fresh = cacheFor("content", databaseName);
    expect(
      await fresh.get(trieHeadKey("products")),
    ).toBeNull();
    await fresh.clearAll();
  });

  it("reports persistent cache purge failures during logout", async () => {
    const failure = new DOMException("blocked", "InvalidStateError");
    const persistent: PersistentObjectCache = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      destroy: async () => {
        throw failure;
      },
    };
    const cache = new TieredObjectCache(
      new MemoryObjectCache(),
      persistent,
    );
    let logoutError: unknown;
    const client = new ThimbleClient({
      reader: new FakeReader(new Map()),
      cache,
      headTtlMs: 1_000,
      channelName: uniqueName(),
      onLogout: (error) => {
        logoutError = error;
      },
    });

    await expect(client.logout()).rejects.toBe(failure);
    expect(logoutError).toBe(failure);
    await expect(
      client.get("products", "one"),
    ).rejects.toThrow("logged out");
  });

  it("retries failed non-broadcast disposal cleanup", async () => {
    const failure = new DOMException("blocked", "InvalidStateError");
    let attempts = 0;
    let logoutCallbacks = 0;
    const persistent: PersistentObjectCache = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      destroy: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw failure;
        }
      },
    };
    const client = new ThimbleClient({
      reader: new FakeReader(new Map()),
      cache: new TieredObjectCache(
        new MemoryObjectCache(),
        persistent,
      ),
      headTtlMs: 1_000,
      channelName: uniqueName(),
      onLogout: () => {
        logoutCallbacks += 1;
      },
    });

    await expect(client.dispose()).rejects.toBe(failure);
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(logoutCallbacks).toBe(0);
  });

  it("rejects stale layout clients before reading retired data", async () => {
    const fixture = trieFixture("products", "product-layout");
    const reader = new FakeReader(fixture.objects);
    const cache = cacheFor("content", uniqueName());
    let changed = false;
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
      layoutGeneration: "old",
      configurationUrl: "/api/config",
      collectionLayouts: { products: "trie" },
      fetchImplementation: (async () =>
        new Response(
          JSON.stringify({ layoutGeneration: "new" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
      onLayoutChange: () => {
        changed = true;
      },
    });

    await expect(
      client.get("products", fixture.id),
    ).rejects.toThrow("configuration changed");
    expect(reader.calls).toBe(0);
    expect(changed).toBe(true);
  });

  it("rejects clients after the active scope key changes", async () => {
    const reader = new FakeReader(new Map());
    const cache = cacheFor("content", uniqueName());
    let changed = false;
    const client = new ThimbleClient({
      reader,
      cache,
      headTtlMs: 10_000,
      channelName: uniqueName(),
      layoutGeneration: "same",
      configurationUrl: "/api/config",
      scopeKeyId: "user:u:v1",
      collectionLayouts: { products: "trie" },
      fetchImplementation: (async () =>
        Response.json({
          layoutGeneration: "same",
          scope: {
            keyId: "user:u:v2",
          },
        })) as typeof fetch,
      onLayoutChange: () => {
        changed = true;
      },
    });

    await expect(
      client.get("products", "one"),
    ).rejects.toThrow("configuration changed");
    expect(reader.calls).toBe(0);
    expect(changed).toBe(true);
  });
});

class FakeReader implements JsonObjectReader {
  calls = 0;
  offline = false;
  error: Error | null = null;

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

    if (this.error) {
      throw this.error;
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

class FakeBundleReader implements PointReadBundleReader {
  calls = 0;

  constructor(
    private readonly result:
      | {
          status: "found";
          bundle: import("../src/trie-protocol.js").TrieReadBundle;
          bytes: number;
        }
      | { status: "fallback" },
  ) {}

  get() {
    this.calls += 1;
    return Promise.resolve(structuredClone(this.result));
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
