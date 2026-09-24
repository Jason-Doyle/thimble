import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import {
  bytesToBase64,
} from "../src/envelope.js";
import { PrefixObjectStore } from "../src/prefix-store.js";
import { loadScopeMaterial } from "../src/server-keys.js";
import { LocalObjectStore } from "../src/stores.js";
import {
  scopeStoragePrefix,
  trieHeadKey,
} from "../src/trie-protocol.js";

describe("scope key rotation", () => {
  it("reads historical envelopes while writing with the new version", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-key-rotation-"),
    );
    const previous = process.env.THIMBLE_MASTER_KEY;
    process.env.THIMBLE_MASTER_KEY = bytesToBase64(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    try {
      const root = new LocalObjectStore(directory);
      const scopeId = "user:test";
      const prefix = scopeStoragePrefix(scopeId);
      const v1 = await loadScopeMaterial({
        scopeId,
        encrypted: true,
        keyVersion: 1,
        local: false,
      });
      const v1Store = new EnvelopeObjectStore(
        new PrefixObjectStore(root, prefix),
        {
          key: v1.key!,
          keyId: v1.keyId!,
          objectKeyPrefix: prefix,
        },
      );
      const first = new ContentAddressedTrieEngine(
        v1Store,
        40,
        v1.addressNode,
      );
      await first.put("products", "one", {
        id: "one",
        value: "version-one",
      });

      const v2 = await loadScopeMaterial({
        scopeId,
        encrypted: true,
        keyVersion: 2,
        local: false,
      });
      const v2Store = new EnvelopeObjectStore(
        new PrefixObjectStore(root, prefix),
        {
          key: v2.key!,
          keyId: v2.keyId!,
          decryptionKeys: new Map([
            [v1.keyId!, v1.key!],
            [v2.keyId!, v2.key!],
          ]),
          objectKeyPrefix: prefix,
        },
      );
      const rotated = new ContentAddressedTrieEngine(
        v2Store,
        40,
        v2.addressNode,
      );

      await expect(
        rotated.get("products", "one"),
      ).resolves.toMatchObject({ value: "version-one" });
      await rotated.put("products", "one", {
        id: "one",
        value: "version-two",
      });
      await expect(
        rotated.get("products", "one"),
      ).resolves.toMatchObject({ value: "version-two" });
    } finally {
      if (previous === undefined) {
        delete process.env.THIMBLE_MASTER_KEY;
      } else {
        process.env.THIMBLE_MASTER_KEY = previous;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts a stale collection rewrite instead of losing a concurrent write", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-key-migration-race-"),
    );
    try {
      const store = new PrefixObjectStore(
        new LocalObjectStore(directory),
        "scope",
      );
      const engine = new ContentAddressedTrieEngine(store);
      await engine.put("products", "one", {
        id: "one",
        value: "before",
      });
      const expectedHead = await store.get(
        trieHeadKey("products"),
      );
      const stale = await engine.scan("products");

      await engine.put("products", "one", {
        id: "one",
        value: "concurrent",
      });
      await expect(
        engine.rewriteIfHeadUnchanged(
          "products",
          stale,
          expectedHead!.etag,
        ),
      ).resolves.toBe(false);
      await expect(
        engine.get("products", "one"),
      ).resolves.toMatchObject({ value: "concurrent" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rewrites snapshot tombstones under the current key", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-snapshot-key-rotation-"),
    );
    const previous = process.env.THIMBLE_MASTER_KEY;
    process.env.THIMBLE_MASTER_KEY = bytesToBase64(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    try {
      const root = new LocalObjectStore(directory);
      const scopeId = "user:snapshot";
      const prefix = scopeStoragePrefix(scopeId);
      const v1 = await loadScopeMaterial({
        scopeId,
        encrypted: true,
        keyVersion: 1,
        local: false,
      });
      const raw = new PrefixObjectStore(root, prefix);
      const first = new ImmutableSnapshotEngine(
        new EnvelopeObjectStore(raw, {
          key: v1.key!,
          keyId: v1.keyId!,
          objectKeyPrefix: prefix,
        }),
        40,
        v1.addressNode,
      );
      await first.put("items", "one", { id: "one", value: 1 });
      await first.delete("items", "one", {
        restoreWindowMs: 30 * 86_400_000,
        purgeGraceMs: 7 * 86_400_000,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });

      const v2 = await loadScopeMaterial({
        scopeId,
        encrypted: true,
        keyVersion: 2,
        local: false,
      });
      const rotating = new ImmutableSnapshotEngine(
        new EnvelopeObjectStore(raw, {
          key: v2.key!,
          keyId: v2.keyId!,
          decryptionKeys: new Map([
            [v1.keyId!, v1.key!],
            [v2.keyId!, v2.key!],
          ]),
          objectKeyPrefix: prefix,
        }),
        40,
        v2.addressNode,
      );
      const stored = await rotating.exportStored("items");
      await rotating.replaceStored("items", stored);

      const currentOnly = new ImmutableSnapshotEngine(
        new EnvelopeObjectStore(raw, {
          key: v2.key!,
          keyId: v2.keyId!,
          objectKeyPrefix: prefix,
        }),
        40,
        v2.addressNode,
      );
      await expect(
        currentOnly.retainedDeletionCount("items"),
      ).resolves.toBe(1);
      await expect(
        currentOnly.restore(
          "items",
          "one",
          new Date("2026-01-02T00:00:00.000Z"),
        ),
      ).resolves.toMatchObject({ value: 1 });
    } finally {
      if (previous === undefined) {
        delete process.env.THIMBLE_MASTER_KEY;
      } else {
        process.env.THIMBLE_MASTER_KEY = previous;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
