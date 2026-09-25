import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContentAddressedTrieEngine,
  ImmutableSnapshotEngine,
  type CollectionIndexConfiguration,
} from "../src/index.js";
import { LocalObjectStore } from "../src/providers/local.js";
import {
  discoverStudioCollections,
  inspectStudioIndex,
  rebuildStudioIndexes,
  studioCollectionCatalog,
  StudioLimitError,
  studioCollectionExport,
  studioDeletedDocuments,
  studioScopes,
} from "../src/studio-api.js";
import {
  trieHeadKey,
  trieIndexKey,
  type TrieHead,
} from "../src/trie-protocol.js";

const indexes: CollectionIndexConfiguration = {
  notes: [
    {
      name: "by-title",
      fields: ["title"],
      mode: "equality",
    },
  ],
};

describe("Studio API helpers", () => {
  it("builds an explicit bounded collection catalog", () => {
    expect(
      studioCollectionCatalog({
        collections: ["settings"],
        collectionLayouts: {
          notes: "snapshot",
        },
        collectionIndexes: {
          tasks: [],
        },
      }),
    ).toEqual(["notes", "settings", "tasks"]);
  });

  it("paginates collection metadata", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-page-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const runtime = {
        store,
        trie: new ContentAddressedTrieEngine(store),
        snapshot: new ImmutableSnapshotEngine(store),
      };
      const collectionNames = Array.from(
        { length: 25 },
        (_, index) => `collection-${String(index).padStart(2, "0")}`,
      );
      const first = await discoverStudioCollections({
        runtime,
        collections: collectionNames,
        collectionLayouts: {},
        collectionIndexes: {},
      });
      const second = await discoverStudioCollections({
        runtime,
        collections: collectionNames,
        collectionLayouts: {},
        collectionIndexes: {},
        offset: first.nextOffset!,
      });

      expect(first.collections).toHaveLength(20);
      expect(first.nextOffset).toBe(20);
      expect(second.collections).toHaveLength(5);
      expect(second.nextOffset).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists granted scopes without adding permissions", () => {
    expect(
      studioScopes([
        {
          scopeId: "user:a",
          permissions: ["read", "write"],
        },
        {
          scopeId: "tenant:b",
          permissions: ["read"],
        },
      ]),
    ).toEqual([
      {
        id: "user:a",
        permissions: ["read", "write"],
      },
      {
        id: "tenant:b",
        permissions: ["read"],
      },
    ]);
  });

  it("discovers collection metadata and index health", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-api-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const snapshot = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      const trie = new ContentAddressedTrieEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await snapshot.put("notes", "note-1", {
        id: "note-1",
        title: "Studio",
      });
      await trie.put("tasks", "task-1", {
        id: "task-1",
        title: "Discovered",
      });

      const page = await discoverStudioCollections({
        runtime: {
          store,
          trie,
          snapshot,
        },
        collections: ["tasks"],
        collectionLayouts: {
          notes: "snapshot",
        },
        collectionIndexes: indexes,
      });

      expect(
        page.collections.map((collection) => collection.name),
      ).toEqual(["notes", "tasks"]);
      expect(page.total).toBe(2);
      expect(page.nextOffset).toBeNull();
      expect(page.collections[0]).toMatchObject({
        name: "notes",
        layout: "snapshot",
        revision: 1,
        hasData: true,
        indexes: [
          {
            status: "active",
            entries: 1,
          },
        ],
      });
      expect(page.collections[1]).toMatchObject({
        name: "tasks",
        layout: "trie",
        revision: 1,
        hasData: true,
      });
      await expect(
        inspectStudioIndex({
          runtime: {
            store,
            trie,
            snapshot,
          },
          collection: "notes",
          layout: "snapshot",
          definition: indexes.notes![0]!,
        }),
      ).resolves.toMatchObject({
        status: "ready",
        entries: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists retained deletions and exports live NDJSON", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-export-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(store);
      await engine.putMany("notes", [
        {
          id: "note-1",
          title: "Live",
        },
        {
          id: "note-2",
          title: "Deleted",
        },
      ]);
      await engine.delete("notes", "note-2", {
        restoreWindowMs: 60_000,
        purgeGraceMs: 60_000,
      });

      let snapshotPageReads = 0;
      const originalGet = store.get.bind(store);
      store.get = async (key) => {
        if (key.includes("/snapshots/")) {
          snapshotPageReads += 1;
        }
        return originalGet(key);
      };

      await expect(
        studioDeletedDocuments({
          engine,
          collection: "notes",
          maximum: 0,
        }),
      ).rejects.toBeInstanceOf(StudioLimitError);
      expect(snapshotPageReads).toBe(0);

      const deleted = await studioDeletedDocuments({
        engine,
        collection: "notes",
      });
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.document.title).toBe("Deleted");

      const exported = await studioCollectionExport({
        engine,
        scopeId: "user:one",
        collection: "notes",
      });
      expect(exported.manifest.records).toBe(1);
      expect(exported.ndjson).toContain('"id":"note-1"');
      expect(exported.ndjson).not.toContain("note-2");
      await expect(
        studioCollectionExport({
          engine,
          scopeId: "user:one",
          collection: "notes",
          maximum: 0,
        }),
      ).rejects.toBeInstanceOf(StudioLimitError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects legacy snapshots before loading an unbounded page", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-legacy-snapshot-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(store);
      await engine.put("notes", "note-1", {
        id: "note-1",
        title: "Legacy",
      });
      const headObject = await store.get(
        "content-snapshot/notes/HEAD.json",
      );
      const head = JSON.parse(
        Buffer.from(headObject!.bytes).toString("utf8"),
      ) as Record<string, unknown>;
      delete head.records;
      delete head.decodedBytes;
      await store.put(
        "content-snapshot/notes/HEAD.json",
        Buffer.from(JSON.stringify(head)),
        { ifMatch: headObject!.etag },
      );

      await expect(
        studioCollectionExport({
          engine,
          scopeId: "user:one",
          collection: "notes",
        }),
      ).rejects.toThrow("metadata is unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies a changed index set only through the rebuild helper", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-index-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const initial = new ImmutableSnapshotEngine(store);
      await initial.put("notes", "note-1", {
        id: "note-1",
        title: "Indexed",
      });
      const configured = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await expect(
        configured.put("notes", "note-2", {
          id: "note-2",
          title: "Blocked",
        }),
      ).rejects.toThrow("do not exactly match");

      await expect(
        rebuildStudioIndexes({
          runtime: {
            store,
            trie: new ContentAddressedTrieEngine(
              store,
              40,
              address,
              false,
              indexes,
            ),
            snapshot: configured,
          },
          collection: "notes",
          layout: "snapshot",
          collectionIndexes: indexes,
          addressNode: address,
        }),
      ).resolves.toEqual({
        records: 1,
        indexes: ["by-title"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds a trie index without reading its missing page", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-trie-index-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const trie = new ContentAddressedTrieEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await trie.put("notes", "note-1", {
        id: "note-1",
        title: "Repair",
      });
      const headObject = await store.get(trieHeadKey("notes"));
      const head = JSON.parse(
        Buffer.from(headObject!.bytes).toString("utf8"),
      ) as TrieHead;
      const reference = head.indexes?.["by-title"];
      await store.delete(
        trieIndexKey(
          "notes",
          "by-title",
          reference!.hash,
        ),
      );

      await expect(
        rebuildStudioIndexes({
          runtime: {
            store,
            trie,
            snapshot: new ImmutableSnapshotEngine(
              store,
              40,
              address,
              false,
              indexes,
            ),
          },
          collection: "notes",
          layout: "trie",
          collectionIndexes: indexes,
          addressNode: address,
        }),
      ).resolves.toMatchObject({
        records: 1,
        indexes: ["by-title"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized index pages from HEAD metadata", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-index-size-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const snapshot = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await snapshot.put("notes", "note-1", {
        id: "note-1",
        title: "Large index",
      });
      const headObject = await store.get(
        "content-snapshot/notes/HEAD.json",
      );
      const head = JSON.parse(
        Buffer.from(headObject!.bytes).toString("utf8"),
      ) as {
        indexes: Record<
          string,
          {
            decodedBytes?: number;
          }
        >;
      };
      head.indexes["by-title"]!.decodedBytes =
        5 * 1024 * 1024;
      await store.put(
        "content-snapshot/notes/HEAD.json",
        Buffer.from(JSON.stringify(head)),
        { ifMatch: headObject!.etag },
      );

      await expect(
        inspectStudioIndex({
          runtime: {
            store,
            trie: new ContentAddressedTrieEngine(store),
            snapshot,
          },
          collection: "notes",
          layout: "snapshot",
          definition: indexes.notes![0]!,
        }),
      ).resolves.toMatchObject({
        status: "oversized",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized index rebuilds before loading snapshot pages", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-rebuild-limit-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const source = new ImmutableSnapshotEngine(store);
      await source.putMany(
        "notes",
        Array.from({ length: 10_001 }, (_, index) => ({
          id: `note-${index}`,
          title: "Bounded",
        })),
      );
      let snapshotPageReads = 0;
      const originalGet = store.get.bind(store);
      store.get = async (key) => {
        if (key.includes("/snapshots/")) {
          snapshotPageReads += 1;
        }
        return originalGet(key);
      };

      await expect(
        rebuildStudioIndexes({
          runtime: {
            store,
            trie: new ContentAddressedTrieEngine(store),
            snapshot: source,
          },
          collection: "notes",
          layout: "snapshot",
          collectionIndexes: indexes,
          addressNode: address,
        }),
      ).rejects.toBeInstanceOf(StudioLimitError);
      expect(snapshotPageReads).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects index rebuild fan-out above the Studio limit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-studio-index-count-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const snapshot = new ImmutableSnapshotEngine(store);
      await snapshot.put("notes", "note-1", {
        id: "note-1",
        title: "Bounded",
      });
      const tooMany: CollectionIndexConfiguration = {
        notes: Array.from({ length: 33 }, (_, index) => ({
          name: `by-title-${index}`,
          fields: ["title"],
          mode: "equality" as const,
        })),
      };

      await expect(
        rebuildStudioIndexes({
          runtime: {
            store,
            trie: new ContentAddressedTrieEngine(store),
            snapshot,
          },
          collection: "notes",
          layout: "snapshot",
          collectionIndexes: tooMany,
          addressNode: address,
        }),
      ).rejects.toThrow("at most 32 indexes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function address(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Buffer.from(digest).toString("hex");
}
