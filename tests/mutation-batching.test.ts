import { describe, expect, it } from "vitest";
import {
  PreconditionFailedError,
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
import {
  decodeJson,
} from "../src/shared-utils.js";
import {
  snapshotHeadKey,
  type SnapshotHead,
} from "../src/snapshot-protocol.js";
import {
  trieHeadKey,
  type TrieHead,
} from "../src/trie-protocol.js";
import {
  MUTATION_BATCH_INDEX_SETS,
  benchmarkDocuments,
  mutationDocuments,
} from "../benchmarks/mutation-batching/regional/scenario.js";

describe("authoritative mutation batches", () => {
  it.each(["snapshot", "trie"] as const)(
    "publishes one %s revision with the same final state",
    async (layout) => {
      const individualStore = new TrackingStore();
      const batchStore = new TrackingStore();
      const individual = engine(
        layout,
        individualStore,
      );
      const batch = engine(layout, batchStore);
      const initial = benchmarkDocuments(128);
      await individual.putMany("notes", initial);
      await batch.putMany("notes", initial);
      individualStore.resetWrites();
      batchStore.resetWrites();
      const changes = mutationDocuments(
        128,
        5,
        0,
      );

      for (const document of changes) {
        await individual.put(
          "notes",
          document.id,
          document,
        );
      }
      await batch.putMany("notes", changes);

      expect(await batch.scan("notes")).toEqual(
        await individual.scan("notes"),
      );
      const individualHead = readHead(
        layout,
        individualStore,
      );
      const batchHead = readHead(
        layout,
        batchStore,
      );
      expect(individualHead.revision).toBe(6);
      expect(batchHead.revision).toBe(2);
      expect({
        ...individualHead,
        revision: 0,
      }).toEqual({
        ...batchHead,
        revision: 0,
      });

      const individualHeadWrites =
        individualStore.completedWrites.filter(
          (key) => key.endsWith("/HEAD.json"),
        );
      const batchHeadWrites =
        batchStore.completedWrites.filter(
          (key) => key.endsWith("/HEAD.json"),
        );
      expect(individualHeadWrites).toHaveLength(5);
      expect(batchHeadWrites).toHaveLength(1);
      expect(
        individualStore.completedWrites.filter(
          (key) => key.includes("/indexes/"),
        ),
      ).toHaveLength(10);
      expect(
        batchStore.completedWrites.filter(
          (key) => key.includes("/indexes/"),
        ),
      ).toHaveLength(2);
      expect(
        batchStore.completedWrites.at(-1),
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
  const indexes =
    MUTATION_BATCH_INDEX_SETS.two;
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

function readHead(
  layout: "snapshot" | "trie",
  store: TrackingStore,
): SnapshotHead | TrieHead {
  const key =
    layout === "snapshot"
      ? snapshotHeadKey("notes")
      : trieHeadKey("notes");
  const object = store.objects.get(key);
  if (!object) {
    throw new Error("Collection HEAD is missing");
  }
  return decodeJson<SnapshotHead | TrieHead>(
    object.bytes,
  );
}

class TrackingStore implements ObjectStore {
  readonly objects = new Map<
    string,
    StoredObject
  >();
  readonly completedWrites: string[] = [];
  private etag = 0;

  get(key: string) {
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
  ) {
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
    this.completedWrites.push(key);
    return Promise.resolve({ etag });
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

  resetWrites() {
    this.completedWrites.length = 0;
  }
}
