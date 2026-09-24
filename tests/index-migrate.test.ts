import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import { rebuildIndexesFromEnvironment } from "../src/index-migrate.js";
import { PrefixObjectStore } from "../src/prefix-store.js";
import { LocalObjectStore } from "../src/providers/local.js";
import { snapshotHeadKey } from "../src/snapshot-protocol.js";
import { scopeStoragePrefix } from "../src/trie-protocol.js";

describe("secondary index migration", () => {
  it("requires explicitly quiescent authorities", async () => {
    const previous = process.env.THIMBLE_MIGRATION_QUIESCENT;
    delete process.env.THIMBLE_MIGRATION_QUIESCENT;
    try {
      await expect(
        rebuildIndexesFromEnvironment(),
      ).rejects.toThrow(
        "Set THIMBLE_MIGRATION_QUIESCENT=true",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.THIMBLE_MIGRATION_QUIESCENT;
      } else {
        process.env.THIMBLE_MIGRATION_QUIESCENT = previous;
      }
    }
  });

  it("rebuilds indexes for the public scope", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "thimble-index-migration-"),
    );
    const names = [
      "THIMBLE_MIGRATION_QUIESCENT",
      "THIMBLE_PROVIDER",
      "THIMBLE_LOCAL_DATA_ROOT",
      "THIMBLE_PREFIX",
      "THIMBLE_SCOPE_ID",
      "THIMBLE_COLLECTIONS",
      "THIMBLE_COLLECTION_LAYOUTS",
      "THIMBLE_COLLECTION_INDEXES",
    ];
    const previous = new Map(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.THIMBLE_MIGRATION_QUIESCENT = "true";
      process.env.THIMBLE_PROVIDER = "local";
      process.env.THIMBLE_LOCAL_DATA_ROOT =
        path.join(root, "objects");
      process.env.THIMBLE_PREFIX = "test";
      process.env.THIMBLE_SCOPE_ID = "public";
      process.env.THIMBLE_COLLECTIONS = "notes";
      process.env.THIMBLE_COLLECTION_LAYOUTS =
        "notes=snapshot";
      process.env.THIMBLE_COLLECTION_INDEXES =
        '{"notes":[{"name":"by-title","fields":["title"],"mode":"equality"}]}';

      const scopePrefix = scopeStoragePrefix("public");
      const store = new EnvelopeObjectStore(
        new PrefixObjectStore(
          new PrefixObjectStore(
            new LocalObjectStore(
              process.env.THIMBLE_LOCAL_DATA_ROOT,
            ),
            "test",
          ),
          scopePrefix,
        ),
        {
          compression: "gzip",
          objectKeyPrefix: scopePrefix,
        },
      );
      await new ImmutableSnapshotEngine(store).put(
        "notes",
        "note-1",
        {
          id: "note-1",
          title: "Indexed",
        },
      );

      await rebuildIndexesFromEnvironment();

      const head = await store.get(snapshotHeadKey("notes"));
      expect(head).not.toBeNull();
      expect(
        JSON.parse(
          Buffer.from(head!.bytes).toString("utf8"),
        ).indexes["by-title"].entries,
      ).toBe(1);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
