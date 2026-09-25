import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContentAddressedTrieEngine,
  defineIndex,
  ImmutableSnapshotEngine,
  MemoryObjectCache,
  planSecondaryIndex,
  ThimbleClient,
  TieredObjectCache,
  snapshotHeadKey,
  snapshotIndexKey,
  snapshotPageKey,
  secondaryIndexPageFromJson,
  trieHeadKey,
  trieIndexKey,
  type CollectionIndexConfiguration,
  type JsonObjectReader,
  type JsonValue,
  type PersistentObjectCache,
  type RemoteJsonObject,
  type SnapshotHead,
  type TrieHead,
  MAX_SECONDARY_INDEX_PAGE_BYTES,
} from "../src/index.js";
import { LocalObjectStore } from "../src/providers/local.js";

type Note = {
  id: string;
  title: string;
  lastModified: number;
  tags?: string[];
};

const noteSummarySchema = {
  parse(value: unknown): Pick<
    Note,
    "id" | "title" | "lastModified"
  > {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("lastModified" in value) ||
      typeof value.lastModified !== "number"
    ) {
      throw new Error("Invalid note summary");
    }
    return value as Pick<
      Note,
      "id" | "title" | "lastModified"
    >;
  },
};

const noteTagsSchema = {
  parse(value: unknown): Pick<Note, "id" | "title" | "tags"> {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("tags" in value) ||
      !Array.isArray(value.tags) ||
      !value.tags.every((tag) => typeof tag === "string")
    ) {
      throw new Error("Invalid note tags");
    }
    return value as Pick<Note, "id" | "title" | "tags">;
  },
};

const indexes: CollectionIndexConfiguration = {
  notes: [
    {
      name: "by-title",
      fields: ["title"],
      mode: "equality",
    },
    {
      name: "by-last-modified",
      fields: ["lastModified"],
      mode: "range",
    },
  ],
};

describe("secondary indexes", () => {
  it.each(["snapshot", "trie"] as const)(
    "publishes and updates %s indexes through the collection head",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `thimble-index-${layout}-`),
      );
      try {
        const store = new LocalObjectStore(directory);
        const engine =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                indexes,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                indexes,
              );

        await engine.put("notes", "note-1", {
          id: "note-1",
          title: "abc",
          lastModified: 1,
        });
        await engine.put("notes", "note-2", {
          id: "note-2",
          title: "abc",
          lastModified: 2,
        });

        const firstHead = await readHead(store, layout);
        expect(firstHead.indexes?.["by-title"]?.entries).toBe(1);
        expect(
          firstHead.indexes?.["by-last-modified"]?.entries,
        ).toBe(2);

        await engine.put("notes", "note-2", {
          id: "note-2",
          title: "changed",
          lastModified: 3,
        });
        const nextHead = await readHead(store, layout);
        expect(nextHead.revision).toBe(3);
        expect(nextHead.indexes?.["by-title"]?.entries).toBe(2);

        await engine.delete("notes", "note-1", {
          restoreWindowMs: 60_000,
          purgeGraceMs: 60_000,
        });
        const deletedHead = await readHead(store, layout);
        expect(deletedHead.indexes?.["by-title"]?.entries).toBe(1);

        await engine.restore("notes", "note-1");
        const restoredHead = await readHead(store, layout);
        expect(restoredHead.indexes?.["by-title"]?.entries).toBe(2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("uses a configured equality index for fluent browser queries", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-browser-index-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await engine.putMany("notes", [
        {
          id: "note-1",
          title: "abc",
          lastModified: 2,
        },
        {
          id: "note-2",
          title: "other",
          lastModified: 1,
        },
      ]);
      const client = new ThimbleClient({
        reader: objectReader(store),
        cache: new TieredObjectCache(
          new MemoryObjectCache(),
          new NullPersistentCache(),
        ),
        headTtlMs: 10_000,
        collectionLayouts: {
          notes: "snapshot",
        },
        collectionIndexes: indexes,
      });

      const result = await client
        .collection<Note>("notes")
        .where((note) => note.title.eq("abc"))
        .orderBy((note) => note.lastModified.asc())
        .get();

      expect(result.plan).toBe("index");
      expect(result.indexName).toBe("by-title");
      expect(result.scannedDocuments).toBe(1);
      expect(result.documents.map((note) => note.id)).toEqual([
        "note-1",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces cold snapshot reads for indexed candidates", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-index-coalesce-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await engine.putMany("notes", [
        {
          id: "note-1",
          title: "same",
          lastModified: 1,
        },
        {
          id: "note-2",
          title: "same",
          lastModified: 2,
        },
      ]);
      const calls = new Map<string, number>();
      const client = new ThimbleClient({
        reader: objectReader(store, calls),
        cache: new TieredObjectCache(
          new MemoryObjectCache(),
          new NullPersistentCache(),
        ),
        headTtlMs: 10_000,
        collectionLayouts: {
          notes: "snapshot",
        },
        collectionIndexes: indexes,
      });

      const result = await client
        .collection<Note>("notes")
        .where((note) => note.title.eq("same"))
        .get();
      const head = await readHead(store, "snapshot");
      const snapshotHash = (head as SnapshotHead).snapshotHash!;

      expect(result.documents).toHaveLength(2);
      expect(
        calls.get(snapshotPageKey("notes", snapshotHash)),
      ).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["snapshot", "trie"] as const)(
    "maintains explicit covering projections for %s indexes",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          `thimble-covering-${layout}-`,
        ),
      );
      try {
        const store = new LocalObjectStore(directory);
        const covering: CollectionIndexConfiguration = {
          notes: [
            defineIndex<Note>(
              "by-title",
              ["title"],
              "equality",
              { include: ["lastModified"] },
            ),
          ],
        };
        const engine =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                covering,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                covering,
              );
        await engine.putMany("notes", [
          {
            id: "note-1",
            title: "same",
            lastModified: 1,
            tags: ["first"],
          },
          {
            id: "note-2",
            title: "same",
            lastModified: 2,
            tags: ["second"],
          },
        ]);

        let page = await coveringPage(store, layout);
        expect(page.projections).toEqual({
          "note-1": {
            id: "note-1",
            title: "same",
            lastModified: 1,
          },
          "note-2": {
            id: "note-2",
            title: "same",
            lastModified: 2,
          },
        });

        await engine.put("notes", "note-1", {
          id: "note-1",
          title: "same",
          lastModified: 3,
          tags: ["updated"],
        });
        page = await coveringPage(store, layout);
        expect(page.projections?.["note-1"]).toEqual({
          id: "note-1",
          title: "same",
          lastModified: 3,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("serves an explicit projection without loading full documents", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-covering-query-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const covering: CollectionIndexConfiguration = {
        notes: [
          defineIndex<Note>(
            "by-title",
            ["title"],
            "equality",
            { include: ["lastModified"] },
          ),
        ],
      };
      const engine = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        covering,
      );
      await engine.putMany("notes", [
        {
          id: "note-1",
          title: "same",
          lastModified: 2,
          tags: ["private"],
        },
        {
          id: "note-2",
          title: "same",
          lastModified: 1,
          tags: ["private"],
        },
      ]);
      const calls = new Map<string, number>();
      const client = new ThimbleClient({
        reader: objectReader(store, calls),
        cache: new TieredObjectCache(
          new MemoryObjectCache(),
          new NullPersistentCache(),
        ),
        headTtlMs: 10_000,
        collectionLayouts: { notes: "snapshot" },
        collectionIndexes: covering,
      });

      const result = await client
        .collection<Note>("notes")
        .where((note) => note.title.eq("same"))
        .orderBy((note) => note.lastModified.asc())
        .select(
          ["title", "lastModified"],
          noteSummarySchema,
        )
        .get();
      const head = (await readHeadForIndex(
        store,
        "snapshot",
        "by-title",
      )) as SnapshotHead;

      expect(result.plan).toBe("index");
      expect(result.documents).toEqual([
        {
          id: "note-2",
          title: "same",
          lastModified: 1,
        },
        {
          id: "note-1",
          title: "same",
          lastModified: 2,
        },
      ]);
      expect(
        calls.get(snapshotPageKey("notes", head.snapshotHash!)),
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads full documents when a selected field is not covered", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-covering-fallback-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const covering: CollectionIndexConfiguration = {
        notes: [
          defineIndex<Note>(
            "by-title",
            ["title"],
            "equality",
            { include: ["lastModified"] },
          ),
        ],
      };
      const engine = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        covering,
      );
      await engine.put("notes", "note-1", {
        id: "note-1",
        title: "same",
        lastModified: 1,
        tags: ["required"],
      });

      const calls = new Map<string, number>();
      const client = new ThimbleClient({
        reader: objectReader(store, calls),
        cache: new TieredObjectCache(
          new MemoryObjectCache(),
          new NullPersistentCache(),
        ),
        headTtlMs: 10_000,
        collectionLayouts: { notes: "snapshot" },
        collectionIndexes: covering,
      });

      const result = await client
        .collection<Note>("notes")
        .where((note) => note.title.eq("same"))
        .select(
          ["title", "tags"],
          noteTagsSchema,
        )
        .get();
      const head = (await readHeadForIndex(
        store,
        "snapshot",
        "by-title",
      )) as SnapshotHead;

      expect(result.documents).toEqual([
        {
          id: "note-1",
          title: "same",
          tags: ["required"],
        },
      ]);
      expect(
        calls.get(snapshotPageKey("notes", head.snapshotHash!)),
      ).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["snapshot", "trie"] as const)(
    "rejects oversized %s projections before writing content objects",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          `thimble-covering-size-${layout}-`,
        ),
      );
      try {
        const store = new LocalObjectStore(directory);
        const covering: CollectionIndexConfiguration = {
          notes: [
            defineIndex<Note>(
              "by-title",
              ["title"],
              "equality",
              { include: ["tags"] },
            ),
          ],
        };
        const engine =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                covering,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                covering,
              );

        await expect(
          engine.put("notes", "note-1", {
            id: "note-1",
            title: "large",
            lastModified: 1,
            tags: ["x".repeat(70 * 1024)],
          }),
        ).rejects.toThrow(
          "covering projection exceeds 65536 decoded bytes",
        );
        expect(
          await store.list(
            layout === "snapshot"
              ? "content-snapshot/notes/"
              : "content-trie/notes/",
          ),
        ).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects aggregate covering index pages above four MiB", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-covering-page-size-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const covering: CollectionIndexConfiguration = {
        notes: [
          defineIndex<Note>(
            "by-title",
            ["title"],
            "equality",
            { include: ["tags"] },
          ),
        ],
      };
      const engine = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        covering,
      );

      await expect(
        engine.putMany(
          "notes",
          Array.from({ length: 70 }, (_, index) => ({
            id: `note-${index}`,
            title: `title-${index}`,
            lastModified: index,
            tags: ["x".repeat(60_000)],
          })),
        ),
      ).rejects.toThrow(
        `exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} decoded bytes`,
      );
      expect(
        await store.list("content-snapshot/notes/"),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("projects stale covering definitions after bounded scan fallback", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-covering-stale-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const oldIndexes: CollectionIndexConfiguration = {
        notes: [
          defineIndex<Note>("by-title", ["title"]),
        ],
      };
      await new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        oldIndexes,
      ).put("notes", "note-1", {
        id: "note-1",
        title: "same",
        lastModified: 1,
        secret: "must-not-return",
      });
      const covering: CollectionIndexConfiguration = {
        notes: [
          defineIndex<Note>(
            "by-title",
            ["title"],
            "equality",
            { include: ["lastModified"] },
          ),
        ],
      };
      const result = await browserClient(
        store,
        "snapshot",
        covering,
      )
        .collection<Note>("notes")
        .where((note) => note.title.eq("same"))
        .select(["title"], {
          parse(value: unknown) {
            return value as Pick<Note, "id" | "title">;
          },
        })
        .get();

      expect(result.plan).toBe("scan");
      expect(result.documents).toEqual([
        {
          id: "note-1",
          title: "same",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bypasses oversized index pages from authenticated HEAD metadata", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-index-client-size-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await engine.put("notes", "note-1", {
        id: "note-1",
        title: "same",
        lastModified: 1,
      });
      const headObject = await store.get(
        snapshotHeadKey("notes"),
      );
      const head = JSON.parse(
        Buffer.from(headObject!.bytes).toString("utf8"),
      ) as SnapshotHead;
      head.indexes!["by-title"]!.decodedBytes =
        MAX_SECONDARY_INDEX_PAGE_BYTES + 1;
      await store.put(
        snapshotHeadKey("notes"),
        Buffer.from(JSON.stringify(head)),
        { ifMatch: headObject!.etag },
      );
      const calls = new Map<string, number>();
      const client = new ThimbleClient({
        reader: objectReader(store, calls),
        cache: new TieredObjectCache(
          new MemoryObjectCache(),
          new NullPersistentCache(),
        ),
        headTtlMs: 10_000,
        collectionLayouts: { notes: "snapshot" },
        collectionIndexes: indexes,
      });

      const result = await client
        .collection<Note>("notes")
        .where((note) => note.title.eq("same"))
        .get();
      const reference = head.indexes!["by-title"]!;

      expect(result.plan).toBe("scan");
      expect(
        calls.get(
          snapshotIndexKey(
            "notes",
            "by-title",
            reference.hash,
          ),
        ),
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back for a stale definition and rebuilds it on the next trie write", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-index-definition-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const oldIndexes: CollectionIndexConfiguration = {
        notes: [
          {
            name: "lookup",
            fields: ["title"],
            mode: "equality",
          },
        ],
      };
      const newIndexes: CollectionIndexConfiguration = {
        notes: [
          {
            name: "lookup",
            fields: ["lastModified"],
            mode: "equality",
          },
        ],
      };
      await new ContentAddressedTrieEngine(
        store,
        40,
        address,
        false,
        oldIndexes,
      ).putMany("notes", [
        {
          id: "note-1",
          title: "First",
          lastModified: 1,
        },
        {
          id: "note-2",
          title: "Second",
          lastModified: 2,
        },
      ]);

      const staleClient = browserClient(store, "trie", newIndexes);
      const staleResult = await staleClient
        .collection<Note>("notes")
        .where((note) => note.lastModified.eq(2))
        .get();
      expect(staleResult.plan).toBe("scan");
      expect(staleResult.documents.map((note) => note.id)).toEqual([
        "note-2",
      ]);

      await expect(
        new ContentAddressedTrieEngine(
          store,
          40,
          address,
          false,
          newIndexes,
        ).put("notes", "note-3", {
          id: "note-3",
          title: "Third",
          lastModified: 2,
        }),
      ).rejects.toThrow("does not match");

      await new ContentAddressedTrieEngine(
        store,
        40,
        address,
        false,
        newIndexes,
        true,
      ).put("notes", "note-3", {
        id: "note-3",
        title: "Third",
        lastModified: 2,
      });

      const rebuiltResult = await browserClient(
        store,
        "trie",
        newIndexes,
      )
        .collection<Note>("notes")
        .where((note) => note.lastModified.eq(2))
        .get();
      expect(rebuiltResult.plan).toBe("index");
      expect(rebuiltResult.documents.map((note) => note.id)).toEqual([
        "note-2",
        "note-3",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous definitions and malformed index pages", () => {
    expect(() =>
      defineIndex<Note>("duplicate", ["title", "title"]),
    ).toThrow("Invalid secondary index configuration");
    expect(() =>
      defineIndex<Note>(
        "invalid-cover",
        ["title"],
        "equality",
        { include: ["title"] },
      ),
    ).toThrow("Invalid secondary index configuration");
    expect(() =>
      defineIndex<Note>(
        "prototype-field",
        ["__proto__" as keyof Note],
      ),
    ).toThrow("Invalid secondary index configuration");

    expect(() =>
      secondaryIndexPageFromJson({
        version: 1,
        definition: {
          name: "by-title",
          fields: ["title"],
          mode: "equality",
        },
        entries: [
          {
            values: ["First"],
            ids: ["note-1"],
          },
          {
            values: ["Second"],
            ids: ["note-1"],
          },
        ],
      }),
    ).toThrow("duplicate document");

    expect(() =>
      secondaryIndexPageFromJson({
        version: 1,
        definition: {
          name: "by-title",
          fields: ["title"],
          mode: "equality",
          include: ["lastModified"],
        },
        entries: [
          {
            values: ["First"],
            ids: ["note-1"],
          },
        ],
      }),
    ).toThrow("missing covering projections");
  });

  it("does not use a sparse range index for ordering alone", () => {
    expect(
      planSecondaryIndex<Note>(indexes.notes!, {
        version: 1,
        orderBy: [
          {
            field: "lastModified",
            direction: "asc",
          },
        ],
      }),
    ).toBeNull();
  });

  it("falls back when equality values cannot be indexed", () => {
    expect(
      planSecondaryIndex<Note>(
        [
          {
            name: "by-tags",
            fields: ["tags"],
            mode: "equality",
          },
        ],
        {
          version: 1,
          where: {
            field: "tags",
            operator: "eq",
            value: ["important"],
          },
        },
      ),
    ).toBeNull();
    expect(
      planSecondaryIndex<Note>(
        [
          {
            name: "range-tags",
            fields: ["tags"],
            mode: "range",
          },
        ],
        {
          version: 1,
          where: {
            field: "tags",
            operator: "eq",
            value: ["important"],
          },
        },
      ),
    ).toBeNull();
  });

  it("keeps trie indexes consistent for duplicate IDs in one batch", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-index-duplicate-id-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ContentAddressedTrieEngine(
        store,
        40,
        address,
        false,
        indexes,
      );
      await engine.putMany("notes", [
        {
          id: "same",
          title: "First",
          lastModified: 1,
        },
        {
          id: "same",
          title: "Second",
          lastModified: 2,
        },
      ]);

      const result = await browserClient(
        store,
        "trie",
        indexes,
      )
        .collection<Note>("notes")
        .where((note) => note.title.eq("Second"))
        .get();
      expect(result.plan).toBe("index");
      expect(result.documents).toEqual([
        {
          id: "same",
          title: "Second",
          lastModified: 2,
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

  });

  it.each(["snapshot", "trie"] as const)(
    "refuses to rewrite indexed %s collections without index configuration",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          `thimble-index-config-${layout}-`,
        ),
      );
      try {
        const store = new LocalObjectStore(directory);
        const configured =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                indexes,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                indexes,
              );
        await configured.put("notes", "note-1", {
          id: "note-1",
          title: "Indexed",
          lastModified: 1,
        });
        const unconfigured =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(store, 40, address)
            : new ContentAddressedTrieEngine(store, 40, address);

        await expect(
          unconfigured.put("notes", "note-2", {
            id: "note-2",
            title: "Unsafe",
            lastModified: 2,
          }),
        ).rejects.toThrow("do not exactly match");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["snapshot", "trie"] as const)(
    "refuses partial %s index configurations during ordinary rewrites",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          `thimble-index-partial-${layout}-`,
        ),
      );
      try {
        const store = new LocalObjectStore(directory);
        const configured =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                indexes,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                indexes,
              );
        await configured.put("notes", "note-1", {
          id: "note-1",
          title: "Indexed",
          lastModified: 1,
        });
        const partial: CollectionIndexConfiguration = {
          notes: [indexes.notes![0]!],
        };
        const rewriter =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                partial,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                partial,
              );

        await expect(
          rewriter.put("notes", "note-2", {
            id: "note-2",
            title: "Unsafe",
            lastModified: 2,
          }),
        ).rejects.toThrow("do not exactly match");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["snapshot", "trie"] as const)(
    "requires explicit migration to add an index to an existing %s collection",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          `thimble-index-add-${layout}-`,
        ),
      );
      try {
        const store = new LocalObjectStore(directory);
        const initial: CollectionIndexConfiguration = {
          notes: [indexes.notes![0]!],
        };
        const original =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                initial,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                initial,
              );
        await original.put("notes", "note-1", {
          id: "note-1",
          title: "Indexed",
          lastModified: 1,
        });
        const expanded =
          layout === "snapshot"
            ? new ImmutableSnapshotEngine(
                store,
                40,
                address,
                false,
                indexes,
              )
            : new ContentAddressedTrieEngine(
                store,
                40,
                address,
                false,
                indexes,
              );

        await expect(
          expanded.put("notes", "note-2", {
            id: "note-2",
            title: "Needs migration",
            lastModified: 2,
          }),
        ).rejects.toThrow("do not exactly match");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

async function readHeadForIndex(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
  indexName: string,
): Promise<SnapshotHead | TrieHead> {
  const key =
    layout === "snapshot"
      ? snapshotHeadKey("notes")
      : trieHeadKey("notes");
  const object = await store.get(key);
  if (!object) {
    throw new Error("Collection head is missing");
  }
  const head = JSON.parse(
    Buffer.from(object.bytes).toString("utf8"),
  ) as SnapshotHead | TrieHead;
  if (!head.indexes?.[indexName]) {
    throw new Error(`Index ${indexName} is missing`);
  }
  return head;
}

async function coveringPage(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
) {
  const head = await readHeadForIndex(
    store,
    layout,
    "by-title",
  );
  const reference = head.indexes!["by-title"]!;
  const key =
    layout === "snapshot"
      ? snapshotIndexKey("notes", "by-title", reference.hash)
      : trieIndexKey("notes", "by-title", reference.hash);
  const object = await store.get(key);
  if (!object) {
    throw new Error("Covering index page is missing");
  }
  return secondaryIndexPageFromJson(
    JSON.parse(
      Buffer.from(object.bytes).toString("utf8"),
    ) as JsonValue,
  );
}

async function readHead(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
): Promise<SnapshotHead | TrieHead> {
  const key =
    layout === "snapshot"
      ? snapshotHeadKey("notes")
      : trieHeadKey("notes");
  const object = await store.get(key);
  if (!object) {
    throw new Error("Collection head is missing");
  }
  const head = JSON.parse(
    Buffer.from(object.bytes).toString("utf8"),
  ) as SnapshotHead | TrieHead;
  const reference = head.indexes?.["by-title"];
  if (!reference) {
    throw new Error("Title index reference is missing");
  }
  const indexKey =
    layout === "snapshot"
      ? snapshotIndexKey("notes", "by-title", reference.hash)
      : trieIndexKey("notes", "by-title", reference.hash);
  expect(await store.get(indexKey)).not.toBeNull();
  return head;
}

function objectReader(
  store: LocalObjectStore,
  calls?: Map<string, number>,
): JsonObjectReader {
  return {
    async get(key, ifNoneMatch): Promise<RemoteJsonObject> {
      calls?.set(key, (calls.get(key) ?? 0) + 1);
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

function browserClient(
  store: LocalObjectStore,
  layout: "snapshot" | "trie",
  collectionIndexes: CollectionIndexConfiguration,
): ThimbleClient {
  return new ThimbleClient({
    reader: objectReader(store),
    cache: new TieredObjectCache(
      new MemoryObjectCache(),
      new NullPersistentCache(),
    ),
    headTtlMs: 10_000,
    collectionLayouts: {
      notes: layout,
    },
    collectionIndexes,
  });
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
