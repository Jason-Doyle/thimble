import { describe, expect, it } from "vitest";
import {
  MemoryObjectCache,
  TieredObjectCache,
  type CachedJsonObject,
  type PersistentObjectCache,
} from "../src/browser/cache.js";

describe("TieredObjectCache failure handling", () => {
  it("continues with memory when IndexedDB is unavailable", async () => {
    const failure = new DOMException("quota", "QuotaExceededError");
    const persistent: PersistentObjectCache = {
      get: async () => {
        throw failure;
      },
      set: async () => {
        throw failure;
      },
      delete: async () => {
        throw failure;
      },
      clear: async () => {
        throw failure;
      },
      destroy: async () => {
        throw failure;
      },
    };
    const cache = new TieredObjectCache(
      new MemoryObjectCache(),
      persistent,
      "content",
    );
    const entry: CachedJsonObject = {
      key: "object",
      etag: "etag",
      value: { id: "object" },
      cachedAt: Date.now(),
      checkedAt: Date.now(),
      immutable: true,
    };

    expect(await cache.get("missing")).toBeNull();
    await expect(cache.set(entry)).resolves.toBeUndefined();
    expect(await cache.get("object")).toEqual(entry);
    expect(cache.metrics().persistentErrors).toBe(1);
  });

  it("surfaces persistent deletion failures during logout cleanup", async () => {
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
      "content",
    );

    await expect(cache.destroy()).rejects.toBe(failure);
    expect(cache.metrics().persistentErrors).toBe(1);
  });
});
