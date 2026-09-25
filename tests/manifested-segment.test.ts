import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  JsonDocument,
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../src/core.js";
import {
  ExperimentalManifestedSegmentEngine,
  manifestedHeadKey,
} from "../src/experimental/manifested-segment.js";
import {
  PreconditionFailedError,
} from "../src/core.js";

describe("experimental manifested segment", () => {
  let store: MemoryStore;
  let engine: ExperimentalManifestedSegmentEngine;

  beforeEach(() => {
    store = new MemoryStore();
    engine = new ExperimentalManifestedSegmentEngine(
      store,
      {
        targetBlockBytes: 16 * 1024,
        collectionFields: {
          notes: [
            { field: "category", mode: "equality" },
            { field: "lastModified", mode: "range" },
          ],
        },
      },
    );
  });

  afterEach(() => {
    store.clear();
  });

  it("reads, scans, and filters immutable ID-range blocks", async () => {
    const documents = notes(500);
    await engine.putMany("notes", documents);
    expect(await engine.get("notes", "note-00250")).toEqual(
      documents[250],
    );
    expect(await engine.scan("notes")).toEqual(documents);

    const equality = await engine.query("notes", {
      field: "category",
      operator: "eq",
      value: "rare",
    });
    expect(equality.documents).toEqual(
      documents.filter(
        (document) => document.category === "rare",
      ),
    );
    expect(equality.blocksSkipped).toBeGreaterThan(0);

    const range = await engine.query("notes", {
      field: "lastModified",
      operator: "between",
      lower: 300,
      upper: 309,
    });
    expect(range.documents).toEqual(
      documents.slice(300, 310),
    );
    expect(range.blocksSkipped).toBeGreaterThan(0);
  });

  it("rewrites one block and one HEAD for a normal update", async () => {
    const documents = notes(500);
    await engine.putMany("notes", documents);
    store.resetMetrics();

    const replacement = {
      ...documents[250]!,
      body: "updated",
      lastModified: 999,
    };
    await engine.put("notes", replacement.id, replacement);

    expect(await engine.get("notes", replacement.id)).toEqual(
      replacement,
    );
    expect(store.puts).toBe(2);
    expect(store.putKeys.filter(
      (key) => key === manifestedHeadKey("notes"),
    )).toHaveLength(1);
  });

  it("retries concurrent HEAD publication without losing writes", async () => {
    await engine.putMany("notes", notes(200));
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        engine.put("notes", `new-${index}`, {
          id: `new-${index}`,
          category: "new",
          lastModified: 1_000 + index,
          body: `new ${index}`,
        }),
      ),
    );
    const documents = await engine.scan("notes");
    expect(documents).toHaveLength(212);
    expect(
      documents.filter((document) =>
        document.id.startsWith("new-"),
      ),
    ).toHaveLength(12);
    expect(engine.diagnostics().casRetries).toBeGreaterThan(0);
  });
});

class MemoryStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  puts = 0;
  putBytes = 0;
  putKeys: string[] = [];
  private etag = 0;

  get(key: string): Promise<StoredObject | null> {
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
    conditions: PutConditions = {},
  ): Promise<{ etag: string }> {
    const current = this.objects.get(key);
    if (conditions.ifNoneMatch && current) {
      return Promise.reject(
        new PreconditionFailedError("exists"),
      );
    }
    if (
      conditions.ifMatch !== undefined &&
      current?.etag !== conditions.ifMatch
    ) {
      return Promise.reject(
        new PreconditionFailedError("etag"),
      );
    }
    const etag = String(++this.etag);
    this.objects.set(key, {
      bytes: bytes.slice(),
      etag,
    });
    this.puts += 1;
    this.putBytes += bytes.byteLength;
    this.putKeys.push(key);
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

  resetMetrics(): void {
    this.puts = 0;
    this.putBytes = 0;
    this.putKeys = [];
  }

  clear(): void {
    this.objects.clear();
  }
}

function notes(count: number): JsonDocument[] {
  const rare = Math.floor(count * 0.05);
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${String(index).padStart(5, "0")}`,
    category: index < rare ? "rare" : "common",
    lastModified: index,
    body: `body ${index} ${"x".repeat(80)}`,
  }));
}
