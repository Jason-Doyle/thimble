import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedReadError } from "../src/core.js";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { LocalObjectStore } from "../src/providers/local.js";
import { readPointBundle } from "../src/read-bundle.js";

describe("bounded point-read bundles", () => {
  it.each(["trie", "snapshot"] as const)(
    "returns the current %s document and cache objects",
    async (layout) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `thimble-bundle-${layout}-`),
      );
      try {
        const store = new LocalObjectStore(directory);
        const engine =
          layout === "trie"
            ? new ContentAddressedTrieEngine(store)
            : new ImmutableSnapshotEngine(store);
        await engine.put("notes", "note-1", {
          id: "note-1",
          title: "Bundled",
        });

        const bundle = await engine.readBundle(
          "notes",
          "note-1",
          {
            maxObjects: 4,
            maxDecodedBytes: 1024 * 1024,
          },
        );

        expect(bundle.layout).toBe(layout);
        expect(bundle.document).toEqual({
          id: "note-1",
          title: "Bundled",
        });
        expect(bundle.objects).toHaveLength(
          layout === "trie" ? 4 : 2,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects an oversized snapshot before loading its page", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-bundle-snapshot-limit-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(store);
      await engine.put("notes", "note-1", {
        id: "note-1",
        body: "x".repeat(4_096),
      });
      let pageReads = 0;
      const originalGet = store.get.bind(store);
      store.get = async (key) => {
        if (key.includes("/snapshots/")) {
          pageReads += 1;
        }
        return originalGet(key);
      };

      await expect(
        engine.readBundle("notes", "note-1", {
          maxObjects: 4,
          maxDecodedBytes: 100,
        }),
      ).rejects.toBeInstanceOf(BoundedReadError);
      expect(pageReads).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a trie bundle before loading a disallowed leaf", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-bundle-trie-limit-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ContentAddressedTrieEngine(store);
      await engine.put("notes", "note-1", {
        id: "note-1",
        title: "Bounded",
      });
      let nodeReads = 0;
      const originalGet = store.get.bind(store);
      store.get = async (key) => {
        if (key.includes("/nodes/")) {
          nodeReads += 1;
        }
        return originalGet(key);
      };

      await expect(
        engine.readBundle("notes", "note-1", {
          maxObjects: 3,
          maxDecodedBytes: 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(BoundedReadError);
      expect(nodeReads).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds the complete serialized response including the document copy", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-bundle-response-limit-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(store);
      await engine.put("notes", "note-1", {
        id: "note-1",
        body: "x".repeat(2_200_000),
      });

      await expect(
        readPointBundle(engine, "notes", "note-1"),
      ).rejects.toBeInstanceOf(BoundedReadError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
