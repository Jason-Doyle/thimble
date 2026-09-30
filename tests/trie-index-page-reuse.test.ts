import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PreconditionFailedError,
  type ObjectStore,
  type PutConditions,
  type StoredObject,
} from "../src/core.js";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import type {
  CollectionIndexConfiguration,
} from "../src/secondary-index.js";

const indexes: CollectionIndexConfiguration = {
  notes: [
    {
      name: "by-title",
      fields: ["title"],
      mode: "equality",
    },
    {
      name: "by-rank",
      fields: ["rank"],
      mode: "range",
    },
  ],
};
const address = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("Trie index page reuse", () => {
  it("removes one read per index without changing stored bytes", async () => {
    const seeded = new MemoryStore();
    await engine(seeded).putMany("notes", [
      {
        id: "note-1",
        title: "First",
        rank: 1,
      },
      {
        id: "note-2",
        title: "Second",
        rank: 2,
      },
    ]);
    const baselineStore = seeded.clone();
    const candidateStore = seeded.clone();
    const baselineReads =
      new DuplicateIndexReadStore(baselineStore);
    baselineStore.resetMetrics();
    candidateStore.resetMetrics();
    const document = {
      id: "note-1",
      title: "Updated",
      rank: 3,
    };

    await engine(baselineReads).put(
      "notes",
      document.id,
      document,
    );
    await engine(candidateStore).put(
      "notes",
      document.id,
      document,
    );

    expect(baselineStore.reads).toBe(8);
    expect(baselineStore.indexReads).toBe(4);
    expect(candidateStore.reads).toBe(6);
    expect(candidateStore.indexReads).toBe(2);
    expect(candidateStore.snapshot()).toEqual(
      baselineStore.snapshot(),
    );
  });

  it("still rejects partial index configuration before candidate writes", async () => {
    const store = new MemoryStore();
    await engine(store).putMany("notes", [
      {
        id: "note-1",
        title: "First",
        rank: 1,
      },
    ]);
    store.resetMetrics();
    const partial = new ContentAddressedTrieEngine(
      store,
      40,
      address,
      false,
      {
        notes: [indexes.notes![0]!],
      },
    );

    await expect(
      partial.put("notes", "note-1", {
        id: "note-1",
        title: "Rejected",
        rank: 2,
      }),
    ).rejects.toThrow(
      "active secondary indexes do not exactly match",
    );
    expect(store.writes).toBe(0);
  });
});

function engine(store: ObjectStore) {
  return new ContentAddressedTrieEngine(
    store,
    40,
    address,
    false,
    indexes,
  );
}

class DuplicateIndexReadStore implements ObjectStore {
  constructor(private readonly delegate: ObjectStore) {}

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.delegate.get(key);
    if (key.includes("/indexes/")) {
      await this.delegate.get(key);
    }
    return object;
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ) {
    return this.delegate.put(
      key,
      bytes,
      conditions,
    );
  }

  delete(key: string) {
    return this.delegate.delete(key);
  }

  list(prefix: string) {
    return this.delegate.list(prefix);
  }
}

class MemoryStore implements ObjectStore {
  private objects = new Map<string, StoredObject>();
  private etag = 0;
  reads = 0;
  indexReads = 0;
  writes = 0;

  get(key: string): Promise<StoredObject | null> {
    this.reads += 1;
    if (key.includes("/indexes/")) {
      this.indexReads += 1;
    }
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
    if (
      (conditions.ifNoneMatch && current) ||
      (conditions.ifMatch !== undefined &&
        current?.etag !== conditions.ifMatch)
    ) {
      return Promise.reject(
        new PreconditionFailedError(key),
      );
    }
    const etag = String(++this.etag);
    this.objects.set(key, {
      bytes: bytes.slice(),
      etag,
    });
    this.writes += 1;
    return Promise.resolve({ etag });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.objects.keys()].filter((key) =>
        key.startsWith(prefix),
      ),
    );
  }

  clone(): MemoryStore {
    const clone = new MemoryStore();
    clone.etag = this.etag;
    clone.objects = new Map(
      [...this.objects].map(([key, object]) => [
        key,
        {
          bytes: object.bytes.slice(),
          etag: object.etag,
        },
      ]),
    );
    return clone;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.objects]
        .sort(([left], [right]) =>
          left.localeCompare(right),
        )
        .map(([key, object]) => [
          key,
          Buffer.from(object.bytes).toString("base64"),
        ]),
    );
  }

  resetMetrics(): void {
    this.reads = 0;
    this.indexReads = 0;
    this.writes = 0;
  }
}
