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

describe("experimental parallel write pipeline", () => {
  it.each(["snapshot", "trie"] as const)(
    "preserves %s objects while overlapping immutable writes",
    async (layout) => {
      const sequentialStore = new DelayedStore();
      const parallelStore = new DelayedStore();
      const sequential = engine(
        layout,
        sequentialStore,
        "sequential",
      );
      const parallel = engine(
        layout,
        parallelStore,
        "parallel",
      );
      const initial = documents(256);
      await sequential.putMany("notes", initial);
      await parallel.putMany("notes", initial);
      sequentialStore.resetMetrics();
      parallelStore.resetMetrics();

      const replacement: JsonDocument = {
        ...initial[17]!,
        body: "updated",
        lastModified: 999,
      };
      await sequential.put(
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
      ).toEqual(await sequential.scan("notes"));
      expect(
        sortedObjects(parallelStore.objects),
      ).toEqual(
        sortedObjects(sequentialStore.objects),
      );
      expect(parallelStore.writes).toBe(
        sequentialStore.writes,
      );
      expect(parallelStore.writtenBytes).toBe(
        sequentialStore.writtenBytes,
      );
      expect(
        parallelStore.maximumConcurrentWrites,
      ).toBeGreaterThan(1);
      expect(
        sequentialStore.maximumConcurrentWrites,
      ).toBe(1);
      expect(parallel.diagnostics()).toMatchObject({
        casRetries: 0,
        writeTotalMs: expect.any(Number),
        writeImmutablePipelineMs:
          expect.any(Number),
        writeHeadCommitMs: expect.any(Number),
      });
    },
  );
});

function engine(
  layout: "snapshot" | "trie",
  store: ObjectStore,
  mode: "sequential" | "parallel",
) {
  const options = {
    mode,
    maximumConcurrency: 3,
  } as const;
  return layout === "snapshot"
    ? new ImmutableSnapshotEngine(
        store,
        40,
        undefined,
        false,
        indexes,
        false,
        options,
      )
    : new ContentAddressedTrieEngine(
        store,
        40,
        undefined,
        false,
        indexes,
        false,
        options,
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
      body: "representative content",
      lastModified: index,
    }),
  );
}

function sortedObjects(
  objects: Map<string, StoredObject>,
) {
  return [...objects.entries()]
    .map(([key, object]) => ({
      key,
      bytes: [...object.bytes],
    }))
    .sort((left, right) =>
      left.key.localeCompare(right.key),
    );
}

class DelayedStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  private etag = 0;
  private activeWrites = 0;
  writes = 0;
  writtenBytes = 0;
  maximumConcurrentWrites = 0;

  async get(key: string) {
    await delay(2);
    const object = this.objects.get(key);
    return object
      ? {
          bytes: object.bytes.slice(),
          etag: object.etag,
        }
      : null;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ) {
    this.activeWrites += 1;
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
      return { etag };
    } finally {
      this.activeWrites -= 1;
    }
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
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}
