import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ImmutableSnapshotEngine,
} from "../../../src/engines/immutable-snapshot.ts";
import {
  MemoryObjectCache,
  TieredObjectCache,
} from "../../../src/browser/cache.ts";
import { ThimbleClient } from "../../../src/browser/client.ts";
import { LocalObjectStore } from "../../../src/providers/local.ts";

export async function createAdapter() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "thimbledb-comparison-"),
  );
  const indexes = {
    notes: [
      {
        name: "by-title",
        fields: ["title"],
        mode: "equality",
      },
    ],
  };
  const store = new LocalObjectStore(directory);
  const engine = new ImmutableSnapshotEngine(
    store,
    40,
    undefined,
    false,
    indexes,
  );
  const client = new ThimbleClient({
    reader: {
      async get(key, ifNoneMatch) {
        const object = await store.get(key);
        if (!object) {
          return { status: "missing", key };
        }
        if (object.etag === ifNoneMatch) {
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
          ),
          bytes: object.bytes.byteLength,
        };
      },
    },
    cache: new TieredObjectCache(
      new MemoryObjectCache(),
      new NullPersistentCache(),
      "none",
    ),
    headTtlMs: 0,
    collectionLayouts: {
      notes: "snapshot",
    },
    collectionIndexes: indexes,
  });
  const notes = client.collection("notes");
  return {
    name: "thimbledb-local-snapshot",
    environment:
      "Node browser client over local snapshot storage with cache disabled and no network authority",
    seed(documents) {
      return engine.putMany("notes", documents);
    },
    get(id) {
      return notes.get(id);
    },
    async findByTitle(title) {
      const result = await notes
        .where((note) => note.title.eq(title))
        .take(100)
        .get();
      if (result.plan !== "index") {
        throw new Error(
          `Expected by-title index, received ${result.plan}`,
        );
      }
      return result.documents;
    },
    scan() {
      return notes.scan();
    },
    put(document) {
      return engine.put("notes", document.id, document);
    },
    async close() {
      client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class NullPersistentCache {
  get() {
    return Promise.resolve(null);
  }
  set() {
    return Promise.resolve();
  }
  delete() {
    return Promise.resolve();
  }
  clear() {
    return Promise.resolve();
  }
  destroy() {
    return Promise.resolve();
  }
}
