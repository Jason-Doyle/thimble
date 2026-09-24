import { describe, expect, it, vi } from "vitest";
import {
  collectionIndexConfiguration,
  ThimbleCollection,
  defineCollection,
  defineIndex,
  type CollectionClient,
} from "../src/index.js";

type Note = {
  id: string;
  title: string;
};

describe("typed collections", () => {
  it("validates reads and writes with schema-compatible parsers", async () => {
    const write = vi.fn().mockResolvedValue({ objects: [] });
    const collection = new ThimbleCollection<Note>(
      client({
        get: async () => ({
          id: "note-1",
          title: "Validated",
        }),
        write,
      }),
      defineCollection("notes", noteSchema),
    );

    await expect(collection.get("note-1")).resolves.toEqual({
      id: "note-1",
      title: "Validated",
    });
    await collection.put({
      id: "note-2",
      title: "Written",
    });
    expect(write).toHaveBeenCalledWith(
      "notes",
      "note-2",
      {
        id: "note-2",
        title: "Written",
      },
    );
  });

  it("uses a point read for ID equality", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "note-1",
      title: "Point read",
    });
    const scan = vi.fn().mockResolvedValue([]);
    const collection = new ThimbleCollection<Note>(
      client({ get, scan }),
      defineCollection("notes", noteSchema),
    );

    const result = await collection.query({
      version: 1,
      where: {
        field: "id",
        operator: "eq",
        value: "note-1",
      },
    });

    expect(result.plan).toBe("point");
    expect(result.documents[0]?.title).toBe("Point read");
    expect(get).toHaveBeenCalledWith("notes", "note-1");
    expect(scan).not.toHaveBeenCalled();
  });

  it("builds typed fluent predicates and ordering", async () => {
    const scan = vi.fn().mockResolvedValue([
      {
        id: "note-2",
        title: "abc",
        lastModified: 2,
      },
      {
        id: "note-1",
        title: "abc",
        lastModified: 1,
      },
      {
        id: "note-3",
        title: "other",
        lastModified: 0,
      },
    ]);
    type IndexedNote = Note & {
      lastModified: number;
    };
    const collection = new ThimbleCollection<IndexedNote>(
      client({ scan }),
      defineCollection("notes"),
    );

    const builder = collection
      .where((note) => note.title.eq("abc"))
      .orderBy((note) => note.lastModified.asc())
      .take(10);
    const result = await builder.get();

    expect(result.documents.map((note) => note.id)).toEqual([
      "note-1",
      "note-2",
    ]);
    expect(builder.toJSON()).toEqual({
      version: 1,
      where: {
        field: "title",
        operator: "eq",
        value: "abc",
      },
      orderBy: [
        {
          field: "lastModified",
          direction: "asc",
        },
      ],
      limit: 10,
    });
  });

  it("surfaces collection and document context on validation failure", async () => {
    const collection = new ThimbleCollection<Note>(
      client({
        get: async () => ({
          id: "note-1",
          title: 1,
        }),
      }),
      defineCollection("notes", noteSchema),
    );

    await expect(collection.get("note-1")).rejects.toThrow(
      "Document validation failed in collection notes for note-1",
    );
  });

  it("requires a finite bound for local predicates", async () => {
    const collection = new ThimbleCollection<Note>(
      client({
        scan: async () => [],
      }),
      defineCollection("notes", noteSchema),
    );

    await expect(
      collection.filter(() => true, Number.POSITIVE_INFINITY),
    ).rejects.toThrow("between 1 and 100000");
  });

  it("rejects duplicate collection index declarations", () => {
    const definition = defineCollection<Note>("notes", {
      indexes: [defineIndex<Note>("by-title", ["title"])],
    });
    expect(() =>
      collectionIndexConfiguration([
        definition,
        definition,
      ]),
    ).toThrow("Duplicate collection definition");
  });
});

const noteSchema = {
  parse(value: unknown): Note {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("title" in value) ||
      typeof value.title !== "string"
    ) {
      throw new Error("Invalid note");
    }
    return value as Note;
  },
};

function client(
  overrides: Partial<CollectionClient>,
): CollectionClient {
  return {
    get: () => Promise.resolve(null),
    scan: () => Promise.resolve([]),
    write: () => Promise.resolve({ objects: [] }),
    delete: () => Promise.resolve({ objects: [] }),
    restore: () => Promise.resolve({ objects: [] }),
    ...overrides,
  } as CollectionClient;
}
