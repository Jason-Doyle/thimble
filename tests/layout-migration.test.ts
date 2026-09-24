import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { LocalObjectStore, PrefixObjectStore } from "../src/stores.js";

describe("collection layout migration", () => {
  it("replaces stale target contents exactly", async () => {
    const fixture = await layoutFixture("replace");
    try {
      await fixture.trie.put("items", "current", {
        id: "current",
        value: 2,
      });
      await fixture.snapshot.put("items", "stale", {
        id: "stale",
        value: 1,
      });

      await fixture.snapshot.replaceStored(
        "items",
        await fixture.trie.exportStored("items"),
      );

      await expect(fixture.snapshot.scan("items")).resolves.toEqual([
        { id: "current", value: 2 },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves retained tombstones during migration", async () => {
    const fixture = await layoutFixture("tombstone");
    try {
      await fixture.trie.put("items", "deleted", {
        id: "deleted",
        value: 1,
      });
      await fixture.trie.delete("items", "deleted", {
        restoreWindowMs: 30 * 86_400_000,
        purgeGraceMs: 7 * 86_400_000,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await fixture.snapshot.replaceStored(
        "items",
        await fixture.trie.exportStored("items"),
      );

      await expect(
        fixture.snapshot.retainedDeletionCount("items"),
      ).resolves.toBe(1);
      await expect(
        fixture.snapshot.restore(
          "items",
          "deleted",
          new Date("2026-01-02T00:00:00.000Z"),
        ),
      ).resolves.toMatchObject({ value: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("drops a retired layout only in quiescent collection mode", async () => {
    const fixture = await layoutFixture("drop");
    try {
      await fixture.trie.put("items", "one", {
        id: "one",
        value: 1,
      });
      const collector = new ContentAddressedTrieEngine(
        fixture.store,
        40,
        undefined,
        true,
      );
      await expect(
        collector.dropCollection("items"),
      ).resolves.toBeGreaterThan(0);
      await expect(
        fixture.store.list("content-trie/items/"),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function layoutFixture(label: string): Promise<{
  store: PrefixObjectStore;
  trie: ContentAddressedTrieEngine;
  snapshot: ImmutableSnapshotEngine;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `thimbledb-layout-${label}-`),
  );
  const store = new PrefixObjectStore(
    new LocalObjectStore(directory),
    "scope",
  );
  return {
    store,
    trie: new ContentAddressedTrieEngine(store),
    snapshot: new ImmutableSnapshotEngine(store),
    cleanup: () =>
      rm(directory, { recursive: true, force: true }),
  };
}
