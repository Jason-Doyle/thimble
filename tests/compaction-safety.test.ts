import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { LogSnapshotEngine } from "../src/engines/log-snapshot.js";
import {
  LocalObjectStore,
  PrefixObjectStore,
} from "../src/stores.js";

describe("production compaction safety", () => {
  it("does not delete trie nodes unless quiescent GC is explicitly enabled", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-safe-trie-"),
    );
    try {
      const store = new PrefixObjectStore(
        new LocalObjectStore(directory),
        "database",
      );
      const engine = new ContentAddressedTrieEngine(store);
      await engine.put("items", "one", { id: "one", value: 1 });
      await engine.put("items", "one", { id: "one", value: 2 });
      const before = await store.list(
        "content-trie/items/nodes/",
      );

      await engine.compact("items");

      expect(
        await store.list("content-trie/items/nodes/"),
      ).toEqual(before);
      await expect(engine.get("items", "one")).resolves.toMatchObject({
        value: 2,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains old log generations after snapshot compaction by default", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-safe-log-"),
    );
    try {
      const store = new PrefixObjectStore(
        new LocalObjectStore(directory),
        "database",
      );
      const engine = new LogSnapshotEngine(store);
      await engine.put("items", "one", { id: "one", value: 1 });
      await engine.compact("items");

      expect(
        await store.list("log-snapshot/items/log/"),
      ).toHaveLength(1);
      await expect(engine.get("items", "one")).resolves.toMatchObject({
        value: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains immutable snapshots unless quiescent GC is explicitly enabled", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-safe-snapshot-"),
    );
    try {
      const store = new PrefixObjectStore(
        new LocalObjectStore(directory),
        "database",
      );
      const engine = new ImmutableSnapshotEngine(store);
      await engine.put("items", "one", { id: "one", value: 1 });
      await engine.put("items", "one", { id: "one", value: 2 });
      await engine.compact("items");
      expect(
        await store.list("content-snapshot/items/snapshots/"),
      ).toHaveLength(2);

      const collector = new ImmutableSnapshotEngine(
        store,
        40,
        undefined,
        true,
      );
      await collector.compact("items");
      expect(
        await store.list("content-snapshot/items/snapshots/"),
      ).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
