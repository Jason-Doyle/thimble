import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import {
  migrateCollectionMetadata,
  migrateMetadataFromEnvironment,
} from "../src/metadata-migrate.js";
import { encodeJson } from "../src/shared-utils.js";
import { LocalObjectStore } from "../src/stores.js";
import {
  snapshotHeadKey,
  type SnapshotHead,
} from "../src/snapshot-protocol.js";
import {
  trieHeadKey,
  trieNodeKey,
  type TrieBranchNode,
  type TrieHead,
  type TrieRootNode,
} from "../src/trie-protocol.js";

describe("bounded-read metadata migration", () => {
  it("requires explicitly quiescent authorities", async () => {
    const previous = process.env.THIMBLE_MIGRATION_QUIESCENT;
    delete process.env.THIMBLE_MIGRATION_QUIESCENT;
    try {
      await expect(
        migrateMetadataFromEnvironment(),
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

  it("adds authenticated bounds to legacy snapshots", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-metadata-snapshot-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ImmutableSnapshotEngine(store);
      await engine.putMany("notes", [
        { id: "note-1", title: "Live" },
        { id: "note-2", title: "Deleted" },
      ]);
      await engine.delete("notes", "note-2", {
        restoreWindowMs: 60_000,
        purgeGraceMs: 60_000,
      });
      const expected = await engine.exportStored("notes");
      const headObject = await store.get(snapshotHeadKey("notes"));
      const legacyHead = JSON.parse(
        Buffer.from(headObject!.bytes).toString("utf8"),
      ) as SnapshotHead;
      delete legacyHead.records;
      delete legacyHead.tombstones;
      delete legacyHead.decodedBytes;
      await store.put(
        snapshotHeadKey("notes"),
        encodeJson(legacyHead),
        { ifMatch: headObject!.etag },
      );

      await expect(
        engine.exportStoredBounded("notes", 10, 1_000_000, 10),
      ).rejects.toThrow("metadata is unavailable");

      await expect(
        migrateCollectionMetadata(engine, "notes"),
      ).resolves.toBe(2);
      await expect(
        engine.exportStoredBounded("notes", 10, 1_000_000, 10),
      ).resolves.toEqual(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adds authenticated bounds to legacy trie branches", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-metadata-trie-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const engine = new ContentAddressedTrieEngine(
        store,
        40,
        address,
      );
      await engine.putMany("notes", [
        { id: "note-1", title: "Live" },
        { id: "note-2", title: "Deleted" },
      ]);
      await engine.delete("notes", "note-2", {
        restoreWindowMs: 60_000,
        purgeGraceMs: 60_000,
      });
      const expected = await engine.exportStored("notes");
      const headObject = await store.get(trieHeadKey("notes"));
      const legacyHead = JSON.parse(
        Buffer.from(headObject!.bytes).toString("utf8"),
      ) as TrieHead;
      const rootObject = await store.get(
        trieNodeKey("notes", legacyHead.rootHash!),
      );
      const legacyRoot = JSON.parse(
        Buffer.from(rootObject!.bytes).toString("utf8"),
      ) as TrieRootNode;
      for (const [first, branchHash] of Object.entries(
        legacyRoot.children,
      )) {
        const branchObject = await store.get(
          trieNodeKey("notes", branchHash),
        );
        const legacyBranch = JSON.parse(
          Buffer.from(branchObject!.bytes).toString("utf8"),
        ) as TrieBranchNode;
        delete legacyBranch.leafMetadata;
        const branchBytes = encodeJson(legacyBranch);
        const legacyBranchHash = await address(branchBytes);
        await store.put(
          trieNodeKey("notes", legacyBranchHash),
          branchBytes,
          { ifNoneMatch: true },
        );
        legacyRoot.children[first] = legacyBranchHash;
      }
      const rootBytes = encodeJson(legacyRoot);
      const legacyRootHash = await address(rootBytes);
      await store.put(
        trieNodeKey("notes", legacyRootHash),
        rootBytes,
        { ifNoneMatch: true },
      );
      legacyHead.rootHash = legacyRootHash;
      await store.put(
        trieHeadKey("notes"),
        encodeJson(legacyHead),
        { ifMatch: headObject!.etag },
      );

      await expect(
        engine.exportStoredBounded("notes", 10, 1_000_000, 10),
      ).rejects.toThrow("metadata is unavailable");

      await expect(
        migrateCollectionMetadata(engine, "notes"),
      ).resolves.toBe(2);
      await expect(
        engine.exportStoredBounded("notes", 10, 1_000_000, 10),
      ).resolves.toEqual(expected);
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
