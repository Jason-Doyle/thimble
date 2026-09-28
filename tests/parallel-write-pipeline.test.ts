import { describe, expect, it } from "vitest";
import {
  PreconditionFailedError,
  type JsonDocument,
  type ObjectStore,
  type PutConditions,
  type StoredObject,
} from "../src/core.js";
import {
  ContentAddressedTrieEngine,
} from "../src/engines/content-trie.js";
import {
  ImmutableSnapshotEngine,
} from "../src/engines/immutable-snapshot.js";
import type {
  CollectionIndexConfiguration,
} from "../src/secondary-index.js";
import {
  createAsyncOperationLimiter,
} from "../src/shared-utils.js";
import {
  snapshotHeadKey,
} from "../src/snapshot-protocol.js";
import {
  trieHeadKey,
} from "../src/trie-protocol.js";

const indexes: CollectionIndexConfiguration = {
  notes: [
    {
      name: "by-category",
      fields: ["category"],
      mode: "equality",
      include: ["title", "lastModified"],
    },
    {
      name: "by-last-modified",
      fields: ["lastModified"],
      mode: "range",
      include: ["title", "category"],
    },
  ],
};

describe("bounded parallel write pipeline", () => {
  it("limits an async operation group to three in flight", async () => {
    const limit = createAsyncOperationLimiter(3);
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          active += 1;
          maximumActive = Math.max(
            maximumActive,
            active,
          );
          await delay(5);
          active -= 1;
        }),
      ),
    );

    expect(maximumActive).toBe(3);
  });

  it.each(["snapshot", "trie"] as const)(
    "preserves %s protocol objects while overlapping immutable writes",
    async (layout) => {
      const serialStore = new DelayedStore(true);
      const parallelStore = new DelayedStore(false);
      const serial = engine(layout, serialStore);
      const parallel = engine(layout, parallelStore);
      const initial = documents(64);
      await serial.putMany("notes", initial);
      await parallel.putMany("notes", initial);
      serialStore.resetMetrics();
      parallelStore.resetMetrics();

      const replacement: JsonDocument = {
        ...initial[17]!,
        category: "updated-category",
        body: "updated body",
        lastModified: 999,
      };
      await serial.put(
        "notes",
        replacement.id,
        replacement,
      );
      await parallel.put(
        "notes",
        replacement.id,
        replacement,
      );

      expect(
        await parallel.scan("notes"),
      ).toEqual(await serial.scan("notes"));
      expect(
        decodedObjects(parallelStore.objects),
      ).toEqual(decodedObjects(serialStore.objects));
      expect(parallelStore.writes).toBe(
        serialStore.writes,
      );
      expect(parallelStore.writtenBytes).toBe(
        serialStore.writtenBytes,
      );
      expect(
        parallelStore.maximumConcurrentWrites,
      ).toBeGreaterThan(1);
      expect(
        parallelStore.maximumConcurrentWrites,
      ).toBeLessThanOrEqual(3);
      expect(
        serialStore.maximumConcurrentWrites,
      ).toBe(1);
      expect(
        parallelStore.headStartedBeforeImmutableWritesSettled,
      ).toBe(false);
      expect(
        parallelStore.completedWrites.at(-1),
      ).toBe(
        layout === "snapshot"
          ? snapshotHeadKey("notes")
          : trieHeadKey("notes"),
      );
    },
  );
});

function engine(
  layout: "snapshot" | "trie",
  store: ObjectStore,
) {
  return layout === "snapshot"
    ? new ImmutableSnapshotEngine(
        store,
        40,
        undefined,
        false,
        indexes,
      )
    : new ContentAddressedTrieEngine(
        store,
        40,
        undefined,
        false,
        indexes,
      );
}

function documents(count: number): JsonDocument[] {
  return Array.from(
    { length: count },
    (_, index) => ({
      id: `note-${String(index).padStart(6, "0")}`,
      title: `Note ${index}`,
      category:
        `category-${String(index % 20).padStart(2, "0")}`,
      body: `representative content ${index}`,
      lastModified: index,
    }),
  );
}

function decodedObjects(
  objects: Map<string, StoredObject>,
) {
  return [...objects.entries()]
    .map(([key, object]) => ({
      key,
      bytes: [...object.bytes],
      value: JSON.parse(
        new TextDecoder().decode(object.bytes),
      ) as unknown,
    }))
    .sort((left, right) =>
      left.key.localeCompare(right.key),
    );
}

class DelayedStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly completedWrites: string[] = [];
  private tail = Promise.resolve();
  private etag = 0;
  private activeWrites = 0;
  private activeImmutableWrites = 0;
  writes = 0;
  writtenBytes = 0;
  maximumConcurrentWrites = 0;
  headStartedBeforeImmutableWritesSettled = false;

  constructor(
    private readonly serializeWrites: boolean,
  ) {}

  async get(key: string) {
    await delay(1);
    const object = this.objects.get(key);
    return object
      ? {
          bytes: object.bytes.slice(),
          etag: object.etag,
        }
      : null;
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ) {
    const operation = () =>
      this.write(key, bytes, conditions);
    if (!this.serializeWrites) {
      return operation();
    }
    const result = this.tail.then(
      operation,
      operation,
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string) {
    return Promise.resolve(
      [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(),
    );
  }

  resetMetrics() {
    this.writes = 0;
    this.writtenBytes = 0;
    this.maximumConcurrentWrites = 0;
    this.headStartedBeforeImmutableWritesSettled =
      false;
    this.completedWrites.length = 0;
  }

  private async write(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions,
  ) {
    const isHead = key.endsWith("/HEAD.json");
    if (
      isHead &&
      this.activeImmutableWrites > 0
    ) {
      this.headStartedBeforeImmutableWritesSettled =
        true;
    }
    this.activeWrites += 1;
    if (!isHead) {
      this.activeImmutableWrites += 1;
    }
    this.maximumConcurrentWrites = Math.max(
      this.maximumConcurrentWrites,
      this.activeWrites,
    );
    try {
      await delay(5);
      const current = this.objects.get(key);
      if (
        (conditions.ifNoneMatch && current) ||
        (conditions.ifMatch !== undefined &&
          current?.etag !== conditions.ifMatch)
      ) {
        throw new PreconditionFailedError(key);
      }
      const etag = String(++this.etag);
      this.objects.set(key, {
        bytes: bytes.slice(),
        etag,
      });
      this.writes += 1;
      this.writtenBytes += bytes.byteLength;
      this.completedWrites.push(key);
      return { etag };
    } finally {
      this.activeWrites -= 1;
      if (!isHead) {
        this.activeImmutableWrites -= 1;
      }
    }
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}
