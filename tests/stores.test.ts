import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PreconditionFailedError } from "../src/core.js";
import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../src/core.js";
import {
  CachedObjectStore,
  LocalObjectStore,
  MeteredObjectStore,
  PrefixObjectStore,
} from "../src/stores.js";

describe("local object store", () => {
  it("models conditional object writes", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "object-store-poc-"),
    );
    try {
      const store = new LocalObjectStore(temporaryDirectory);
      const first = await store.put(
        "records/item.json",
        Buffer.from('{"value":1}'),
        { ifNoneMatch: true },
      );

      await expect(
        store.put(
          "records/item.json",
          Buffer.from('{"value":2}'),
          { ifNoneMatch: true },
        ),
      ).rejects.toBeInstanceOf(PreconditionFailedError);

      await expect(
        store.put(
          "records/item.json",
          Buffer.from('{"value":2}'),
          { ifMatch: "wrong-etag" },
        ),
      ).rejects.toBeInstanceOf(PreconditionFailedError);

      await store.put(
        "records/item.json",
        Buffer.from('{"value":2}'),
        { ifMatch: first.etag },
      );

      const stored = await store.get("records/item.json");
      expect(Buffer.from(stored!.bytes).toString("utf8")).toBe(
        '{"value":2}',
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("distinguishes location and content cache policies", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "object-cache-poc-"),
    );
    try {
      const metered = new MeteredObjectStore(
        new LocalObjectStore(temporaryDirectory),
      );
      const cache = new CachedObjectStore(metered, {
        mutableTtlMs: 1_000,
        maxBytes: 1024 * 1024,
        maxEntries: 100,
      });

      await metered.put(
        "content-trie/products/HEAD.json",
        Buffer.from('{"revision":1,"rootHash":"root"}'),
      );
      await metered.put(
        "content-trie/products/nodes/root.json",
        Buffer.from('{"kind":"root","children":{"a":"branch"}}'),
      );
      await metered.put(
        "content-trie/products/nodes/leaf.json",
        Buffer.from('{"kind":"leaf","documents":{"p":{"id":"p"}}}'),
      );

      metered.reset();
      cache.setPolicy("locations");
      await cache.get("content-trie/products/HEAD.json");
      await cache.get("content-trie/products/HEAD.json");
      await cache.get("content-trie/products/nodes/root.json");
      await cache.get("content-trie/products/nodes/root.json");
      await cache.get("content-trie/products/nodes/leaf.json");
      await cache.get("content-trie/products/nodes/leaf.json");

      expect(metered.snapshot().get.count).toBe(4);
      expect(cache.snapshot().hits).toBe(2);

      metered.reset();
      cache.resetMetrics();
      cache.setPolicy("content");
      await cache.get("content-trie/products/nodes/leaf.json");
      await cache.get("content-trie/products/nodes/leaf.json");

      expect(metered.snapshot().get.count).toBe(1);
      expect(cache.snapshot().hits).toBe(1);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps empty-prefix listings inside their configured namespace", async () => {
    const delegate = new PrefixMatchingStore([
      "app/one.json",
      "app/nested/two.json",
      "app-other/private.json",
    ]);
    const store = new PrefixObjectStore(delegate, "app");

    await expect(store.list("")).resolves.toEqual([
      "nested/two.json",
      "one.json",
    ]);
    expect(delegate.lastPrefix).toBe("app/");
  });
});

class PrefixMatchingStore implements ObjectStore {
  lastPrefix = "";

  constructor(private readonly keys: string[]) {}

  get(_key: string): Promise<StoredObject | null> {
    return Promise.resolve(null);
  }

  put(
    _key: string,
    _bytes: Uint8Array,
    _conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    return Promise.resolve({ etag: "unused" });
  }

  delete(_key: string): Promise<void> {
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    this.lastPrefix = prefix;
    return Promise.resolve(
      this.keys.filter((key) => key.startsWith(prefix)).sort(),
    );
  }
}
