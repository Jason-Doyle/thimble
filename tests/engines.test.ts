import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { DatabaseEngine, JsonDocument } from "../src/core.js";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import { LogSnapshotEngine } from "../src/engines/log-snapshot.js";
import { MonolithEngine } from "../src/engines/monolith.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import {
  LocalObjectStore,
  PrefixObjectStore,
} from "../src/stores.js";

const factories: Array<{
  name: string;
  create(store: PrefixObjectStore): DatabaseEngine;
}> = [
  {
    name: "monolithic JSON",
    create: (store) => new MonolithEngine(store),
  },
  {
    name: "append log and snapshot",
    create: (store) => new LogSnapshotEngine(store),
  },
  {
    name: "content-addressed trie",
    create: (store) => new ContentAddressedTrieEngine(store),
  },
  {
    name: "immutable snapshot",
    create: (store) => new ImmutableSnapshotEngine(store),
  },
];

describe.each(factories)("$name engine", ({ name, create }) => {
  let temporaryDirectory: string;
  let store: PrefixObjectStore;
  let engine: DatabaseEngine;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "object-db-poc-"),
    );
    store = new PrefixObjectStore(
      new LocalObjectStore(temporaryDirectory),
      name.replaceAll(" ", "-"),
    );
    engine = create(store);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("stores, updates, scans, and compacts documents", async () => {
    const seed = Array.from({ length: 12 }, (_, index) =>
      product(index),
    );
    await engine.putMany("products", seed);

    expect(await engine.get("products", seed[3]!.id)).toEqual(seed[3]);

    const replacement = {
      ...seed[3]!,
      priceCents: 9_999,
    };
    await engine.put("products", replacement.id, replacement);

    const concurrent = Array.from({ length: 10 }, (_, index) =>
      product(index + 100),
    );
    await Promise.all(
      concurrent.map((document) =>
        engine.put("products", document.id, document),
      ),
    );

    const beforeCompaction = await engine.scan("products");
    expect(beforeCompaction).toHaveLength(22);
    expect(
      beforeCompaction.find(
        (document) => document.id === replacement.id,
      ),
    ).toEqual(replacement);

    await engine.compact("products");

    const afterCompaction = await engine.scan("products");
    expect(afterCompaction).toEqual(beforeCompaction);
  });

  it("treats prototype-reserved document ids as ordinary keys", async () => {
    const protoDocument: JsonDocument = {
      id: "__proto__",
      name: "Prototype record",
    };
    const inheritedName: JsonDocument = {
      id: "toString",
      name: "Inherited-name record",
    };

    await engine.putMany("products", [
      protoDocument,
      inheritedName,
    ]);

    expect(await engine.get("products", "__proto__")).toEqual(
      protoDocument,
    );
    expect(await engine.get("products", "toString")).toEqual(
      inheritedName,
    );
  });

  it("rejects path-like collection names consistently", async () => {
    await expect(
      engine.put("..", "item", { id: "item" }),
    ).rejects.toThrow("cannot be");
    await expect(
      engine.scan("a/b"),
    ).rejects.toThrow("must be");
  });
});

describe("content-addressed trie maintenance", () => {
  it("removes unreachable nodes after a quiescent update", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "object-db-poc-trie-"),
    );
    try {
      const store = new PrefixObjectStore(
        new LocalObjectStore(temporaryDirectory),
        "trie",
      );
      const engine = new ContentAddressedTrieEngine(store);
      const gcEngine = new ContentAddressedTrieEngine(
        store,
        40,
        undefined,
        true,
      );
      const documents = Array.from({ length: 32 }, (_, index) =>
        product(index),
      );

      await engine.putMany("products", documents);
      const initialCount = (await store.list("")).length;

      await engine.put("products", documents[0]!.id, {
        ...documents[0]!,
        stock: 1,
      });
      const beforeCompaction = (await store.list("")).length;
      expect(beforeCompaction).toBeGreaterThan(initialCount);

      await gcEngine.compact("products");
      const afterCompaction = (await store.list("")).length;
      expect(afterCompaction).toBeLessThan(beforeCompaction);
      expect(await engine.get("products", documents[0]!.id)).toMatchObject({
        stock: 1,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

function product(index: number): JsonDocument {
  return {
    id: `product-${index.toString().padStart(4, "0")}`,
    name: `Product ${index}`,
    category: index % 2 === 0 ? "home" : "office",
    priceCents: 1_000 + index,
    stock: 20,
  };
}
