import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryObjectCache,
  ThimbleClient,
  TieredObjectCache,
  buildSecondaryIndexPage,
  snapshotHeadKey,
  trieHeadKey,
  type CollectionIndexConfiguration,
  type JsonObjectReader,
  type JsonValue,
  type PersistentObjectCache,
  type RemoteJsonObject,
  type SnapshotHead,
  type TrieHead,
} from "../src/index.js";
import {
  ContentAddressedTrieEngine,
} from "../src/engines/content-trie.js";
import {
  ImmutableSnapshotEngine,
} from "../src/engines/immutable-snapshot.js";
import {
  buildExperimentalPartitionedIndex,
  experimentalPartitionedIndexManifestFromReference,
  mergeExperimentalPartitionedIndexPages,
  updateExperimentalPartitionedIndex,
  validateExperimentalPartitionedIndexShard,
  type ExperimentalPartitionedIndexConfiguration,
} from "../src/experimental/partitioned-secondary-index.js";
import { secondaryIndexPageFromJson } from "../src/secondary-index.js";
import { inspectStudioIndex } from "../src/studio-api.js";
import { LocalObjectStore } from "../src/stores.js";

type Note = {
  id: string;
  title: string;
  category: string;
  lastModified: number;
};

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
const partitions: ExperimentalPartitionedIndexConfiguration = {
  notes: {
    "by-category": 8,
    "by-last-modified": 8,
  },
};

describe("experimental partitioned secondary indexes", () => {
  it("merges deterministic shards to the monolithic page", async () => {
    const definition = indexes.notes![0]!;
    const documents = notes(256);
    const prepared = await buildExperimentalPartitionedIndex(
      definition,
      documents,
      8,
      address,
    );
    const manifest =
      experimentalPartitionedIndexManifestFromReference(
        prepared.reference,
        definition,
      );
    expect(manifest?.partitions).toBe(8);
    expect(prepared.objects).toHaveLength(8);

    const pages = prepared.objects.map((object, partition) => {
      const page = secondaryIndexPageFromJson(
        JSON.parse(
          Buffer.from(object.bytes).toString("utf8"),
        ) as JsonValue,
      );
      validateExperimentalPartitionedIndexShard(
        manifest!.shards[partition]!,
        page,
        object.bytes.byteLength,
        definition,
      );
      return page;
    });
    expect(
      mergeExperimentalPartitionedIndexPages(
        manifest!,
        pages,
      ),
    ).toEqual(
      buildSecondaryIndexPage(definition, documents),
    );
  });

  it("rewrites only the changed ID partition", async () => {
    const definition = indexes.notes![0]!;
    const documents = notes(256);
    const initial = await buildExperimentalPartitionedIndex(
      definition,
      documents,
      8,
      address,
    );
    const manifest =
      experimentalPartitionedIndexManifestFromReference(
        initial.reference,
        definition,
      )!;
    const pages = new Map(
      initial.objects.map((object) => [
        object.hash,
        secondaryIndexPageFromJson(
          JSON.parse(
            Buffer.from(object.bytes).toString("utf8"),
          ) as JsonValue,
        ),
      ]),
    );
    const replacement = {
      ...documents[17]!,
      category: "changed",
      lastModified: 999,
    };
    const updated = await updateExperimentalPartitionedIndex(
      manifest,
      definition,
      [{ id: replacement.id, document: replacement }],
      async (shard) => pages.get(shard.hash)!,
      address,
    );
    expect(updated.objects).toHaveLength(1);

    for (const object of updated.objects) {
      pages.set(
        object.hash,
        secondaryIndexPageFromJson(
          JSON.parse(
            Buffer.from(object.bytes).toString("utf8"),
          ) as JsonValue,
        ),
      );
    }
    const updatedManifest =
      experimentalPartitionedIndexManifestFromReference(
        updated.reference,
        definition,
      )!;
    const merged = mergeExperimentalPartitionedIndexPages(
      updatedManifest,
      updatedManifest.shards.map((shard) => pages.get(shard.hash)!),
    );
    expect(merged).toEqual(
      buildSecondaryIndexPage(
        definition,
        documents.map((document) =>
          document.id === replacement.id
            ? replacement
            : document,
        ),
      ),
    );
  });

  it.each(["snapshot", "trie"] as const)(
    "publishes atomic partition references and serves %s queries",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `thimble-partitioned-${layout}-`),
      );
      try {
        const store = new LocalObjectStore(directory);
        const engine = createEngine(store, layout);
        await engine.putMany("notes", notes(512));
        const firstHead = await readHead(store, layout);
        for (const reference of Object.values(
          firstHead.indexes ?? {},
        )) {
          expect(
            reference.experimentalPartitions?.partitions,
          ).toBe(8);
          expect(
            reference.experimentalPartitions?.shards.length,
          ).toBe(8);
        }
        await expect(
          inspectStudioIndex({
            runtime: {
              store,
              trie:
                layout === "trie"
                  ? engine as ContentAddressedTrieEngine
                  : new ContentAddressedTrieEngine(store),
              snapshot:
                layout === "snapshot"
                  ? engine as ImmutableSnapshotEngine
                  : new ImmutableSnapshotEngine(store),
            },
            collection: "notes",
            layout,
            definition: indexes.notes![0]!,
          }),
        ).resolves.toMatchObject({
          status: "ready",
          entries: 20,
        });

        const client = browserClient(store, layout);
        await expect(
          client.queryDocuments<Note>(
            "notes",
            {
              version: 1,
              where: {
                field: "category",
                operator: "eq",
                value: "category-03",
              },
              limit: 100,
              maxScanDocuments: 512,
            },
            ["title", "lastModified"],
          ),
        ).resolves.toMatchObject({
          plan: "index",
          documents: { length: 26 },
        });
        const changedIndexes: CollectionIndexConfiguration = {
          notes: [
            {
              ...indexes.notes![0]!,
              include: ["lastModified"],
            },
            indexes.notes![1]!,
          ],
        };
        const incompatible =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                changedIndexes,
                false,
                partitions,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                changedIndexes,
                false,
                partitions,
              );
        await expect(
          incompatible.put("notes", "note-000001", {
            id: "note-000001",
            title: "Incompatible",
            category: "category-01",
            lastModified: 1,
          }),
        ).rejects.toThrow("definition changed");

        await engine.put("notes", "note-000017", {
          id: "note-000017",
          title: "Changed",
          category: "changed",
          lastModified: 999,
        });
        const nextHead = await readHead(store, layout);
        for (const definition of indexes.notes!) {
          const before =
            firstHead.indexes![definition.name]!
              .experimentalPartitions!.shards;
          const after =
            nextHead.indexes![definition.name]!
              .experimentalPartitions!.shards;
          expect(
            after.filter(
              (shard, index) =>
                shard.hash !== before[index]?.hash,
            ),
          ).toHaveLength(1);
        }
        client.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["snapshot", "trie"] as const)(
    "retains active %s shards during quiescent compaction",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `thimble-partitioned-gc-${layout}-`),
      );
      try {
        const store = new LocalObjectStore(directory);
        const engine = createEngine(store, layout, true);
        await engine.putMany("notes", notes(128));
        await engine.put("notes", "note-000017", {
          id: "note-000017",
          title: "Changed",
          category: "changed",
          lastModified: 999,
        });
        await engine.compact("notes");

        const client = browserClient(store, layout);
        await expect(
          client.queryDocuments<Note>("notes", {
            version: 1,
            where: {
              field: "category",
              operator: "eq",
              value: "changed",
            },
            limit: 1,
            maxScanDocuments: 128,
          }),
        ).resolves.toMatchObject({
          plan: "index",
          documents: [
            {
              id: "note-000017",
            },
          ],
        });
        client.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

function createEngine(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
  allowGarbageCollection = false,
) {
  return layout === "snapshot"
    ? new ImmutableSnapshotEngine(
        store,
        40,
        address,
        allowGarbageCollection,
        indexes,
        false,
        partitions,
      )
    : new ContentAddressedTrieEngine(
        store,
        40,
        address,
        allowGarbageCollection,
        indexes,
        false,
        partitions,
      );
}

async function readHead(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
): Promise<SnapshotHead | TrieHead> {
  const object = await store.get(
    layout === "snapshot"
      ? snapshotHeadKey("notes")
      : trieHeadKey("notes"),
  );
  if (!object) {
    throw new Error("Collection head is missing");
  }
  return JSON.parse(
    Buffer.from(object.bytes).toString("utf8"),
  ) as SnapshotHead | TrieHead;
}

function browserClient(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
): ThimbleClient {
  return new ThimbleClient({
    reader: objectReader(store),
    cache: new TieredObjectCache(
      new MemoryObjectCache(),
      new NullPersistentCache(),
    ),
    headTtlMs: 10_000,
    collectionLayouts: { notes: layout },
    collectionIndexes: indexes,
  });
}

function objectReader(store: LocalObjectStore): JsonObjectReader {
  return {
    async get(key, ifNoneMatch): Promise<RemoteJsonObject> {
      const object = await store.get(key);
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
        value: JSON.parse(
          Buffer.from(object.bytes).toString("utf8"),
        ) as JsonValue,
        bytes: object.bytes.byteLength,
      };
    },
  };
}

function notes(count: number): Note[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${String(index).padStart(6, "0")}`,
    title: `Note ${index}`,
    category: `category-${String(index % 20).padStart(2, "0")}`,
    lastModified: index,
  }));
}

async function address(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Buffer.from(digest).toString("hex");
}

class NullPersistentCache implements PersistentObjectCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  clear(): Promise<void> {
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}
