import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { LocalObjectStore, PrefixObjectStore } from "../src/stores.js";

const day = 24 * 60 * 60 * 1_000;
const policy = {
  restoreWindowMs: 30 * day,
  purgeGraceMs: 7 * day,
  now: new Date("2026-01-01T00:00:00.000Z"),
};

describe("content trie deletion retention", () => {
  it("hides a tombstoned document and restores it within retention", async () => {
    const fixture = await engineFixture("restore");
    try {
      await fixture.engine.put("products", "one", {
        id: "one",
        value: "visible",
      });

      describe("immutable snapshot deletion retention", () => {
        it("uses the same tombstone and restore policy", async () => {
          const directory = await mkdtemp(
            path.join(os.tmpdir(), "thimbledb-snapshot-delete-"),
          );
          try {
            const engine = new ImmutableSnapshotEngine(
              new PrefixObjectStore(
                new LocalObjectStore(directory),
                "scope",
              ),
            );
            await engine.put("products", "one", {
              id: "one",
              value: "snapshot",
            });
            await expect(
              engine.delete("products", "one", policy),
            ).resolves.toBe(true);
            await expect(
              engine.get("products", "one"),
            ).resolves.toBeNull();
            await expect(
              engine.restore(
                "products",
                "one",
                new Date("2026-01-02T00:00:00.000Z"),
              ),
            ).resolves.toMatchObject({ value: "snapshot" });
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        });
      });

      await expect(
        fixture.engine.delete("products", "one", policy),
      ).resolves.toBe(true);
      await expect(
        fixture.engine.get("products", "one"),
      ).resolves.toBeNull();
      await expect(
        fixture.engine.scan("products"),
      ).resolves.toEqual([]);

      await expect(
        fixture.engine.restore(
          "products",
          "one",
          new Date("2026-01-15T00:00:00.000Z"),
        ),
      ).resolves.toMatchObject({ value: "visible" });
      await expect(
        fixture.engine.get("products", "one"),
      ).resolves.toMatchObject({ value: "visible" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("purges expired tombstones from the live tree", async () => {
    const fixture = await engineFixture("purge");
    try {
      await fixture.engine.put("products", "one", {
        id: "one",
        value: "deleted",
      });
      await fixture.engine.delete("products", "one", policy);

      await expect(
        fixture.engine.purgeDeleted(
          "products",
          new Date("2026-02-08T00:00:00.000Z"),
        ),
      ).resolves.toBe(1);
      await expect(
        fixture.engine.restore(
          "products",
          "one",
          new Date("2026-02-08T00:00:00.000Z"),
        ),
      ).resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not overwrite a concurrent update with stale deleted content", async () => {
    const fixture = await engineFixture("race");
    try {
      await fixture.engine.put("products", "one", {
        id: "one",
        value: "before",
      });
      await Promise.all([
        fixture.engine.delete("products", "one", policy),
        fixture.engine.put("products", "one", {
          id: "one",
          value: "concurrent",
        }),
      ]);

      const visible = await fixture.engine.get("products", "one");
      if (visible) {
        expect(visible.value).toBe("concurrent");
      } else {
        await expect(
          fixture.engine.restore(
            "products",
            "one",
            new Date("2026-01-02T00:00:00.000Z"),
          ),
        ).resolves.toMatchObject({ value: "concurrent" });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("tombstones an entire collection for scope erasure", async () => {
    const fixture = await engineFixture("erase");
    try {
      await fixture.engine.putMany("products", [
        { id: "one", value: 1 },
        { id: "two", value: 2 },
      ]);
      await expect(
        fixture.engine.eraseAll("products", policy),
      ).resolves.toBe(2);
      await expect(
        fixture.engine.scan("products"),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function engineFixture(label: string): Promise<{
  engine: ContentAddressedTrieEngine;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `thimbledb-delete-${label}-`),
  );
  return {
    engine: new ContentAddressedTrieEngine(
      new PrefixObjectStore(
        new LocalObjectStore(directory),
        "scope",
      ),
    ),
    cleanup: () =>
      rm(directory, { recursive: true, force: true }),
  };
}
