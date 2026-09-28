import { describe, expect, it } from "vitest";
import {
  ContentAddressedTrieEngine,
  ImmutableSnapshotEngine,
  MUTATION_BATCH_MAX_DOCUMENTS,
  MutationBatchRequestError,
  mutationBatchDocuments,
  type JsonDocument,
} from "../src/index.js";
import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../src/core.js";
import {
  PreconditionFailedError,
} from "../src/core.js";

describe("mutation batches", () => {
  it("rejects oversized and duplicate document groups", () => {
    expect(() =>
      mutationBatchDocuments({
        version: 1,
        documents: Array.from(
          {
            length:
              MUTATION_BATCH_MAX_DOCUMENTS + 1,
          },
          (_, index) => ({
            id: `note-${index}`,
          }),
        ),
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 413,
        code: "mutation_batch_too_large",
      }) as MutationBatchRequestError,
    );
    expect(() =>
      mutationBatchDocuments({
        version: 1,
        documents: [
          { id: "same" },
          { id: "same" },
        ],
      }),
    ).toThrow("duplicate document id same");
  });

  it.each(["snapshot", "trie"] as const)(
    "returns a bounded %s cache bundle for all changed documents",
    async (layout) => {
      const store = new MemoryStore();
      const engine =
        layout === "snapshot"
          ? new ImmutableSnapshotEngine(store)
          : new ContentAddressedTrieEngine(store);
      const documents: JsonDocument[] =
        Array.from(
          { length: 5 },
          (_, index) => ({
            id: `note-${index}`,
            value: index,
          }),
        );
      await engine.putMany("notes", documents);

      const bundle =
        await engine.readMutationBundle(
          "notes",
          documents,
          {
            maxObjects: 42,
            maxDecodedBytes: 16 * 1024 * 1024,
          },
        );

      expect(bundle).toMatchObject({
        version: 1,
        collection: "notes",
        revision: 1,
        documents,
        layout,
        cacheComplete: true,
      });
      expect(
        bundle.objects.some((object) =>
          object.key.endsWith("/HEAD.json"),
        ),
      ).toBe(true);
    },
  );

  it("falls back to a partial cache bundle after a committed write", async () => {
    const store = new MemoryStore();
    const engine = new ImmutableSnapshotEngine(store);
    const documents = Array.from(
      { length: 20 },
      (_, index) => ({
        id: `note-${index}`,
        value: "x".repeat(1_000),
      }),
    );
    await engine.putMany("notes", documents);

    const bundle =
      await engine.readMutationBundle(
        "notes",
        documents,
        {
          maxObjects: 42,
          maxDecodedBytes: 1_024,
        },
      );

    expect(bundle.cacheComplete).toBe(false);
    expect(bundle.revision).toBe(1);
    expect(bundle.documents).toEqual(documents);
    expect(bundle.objects).toHaveLength(1);
  });
});

class MemoryStore implements ObjectStore {
  private readonly values = new Map<
    string,
    StoredObject
  >();
  private nextEtag = 0;

  get(key: string) {
    const value = this.values.get(key);
    return Promise.resolve(
      value
        ? {
            bytes: value.bytes.slice(),
            etag: value.etag,
          }
        : null,
    );
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ) {
    const current = this.values.get(key);
    if (
      (conditions.ifNoneMatch && current) ||
      (conditions.ifMatch !== undefined &&
        current?.etag !== conditions.ifMatch)
    ) {
      return Promise.reject(
        new PreconditionFailedError(key),
      );
    }
    const etag = String(++this.nextEtag);
    this.values.set(key, {
      bytes: bytes.slice(),
      etag,
    });
    return Promise.resolve({ etag });
  }

  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }

  list(prefix: string) {
    return Promise.resolve(
      [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(),
    );
  }
}
