import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PreconditionFailedError,
  type JsonDocument,
  type JsonValue,
  type ObjectStore,
  type PutConditions,
  type StoredObject,
} from "../src/core.js";
import { ContentAddressedTrieEngine } from "../src/engines/content-trie.js";
import {
  applyClientAssistedTrieWrite,
  issueClientTrieWriteContext,
  type ClientTrieWriteContext,
} from "../src/experimental/client-write-context.js";
import {
  decodeJson,
  encodeJson,
} from "../src/shared-utils.js";
import {
  trieHeadKey,
  trieIndexKey,
  type TrieHead,
} from "../src/trie-protocol.js";
import type {
  CollectionIndexConfiguration,
} from "../src/secondary-index.js";

const collection = "notes";
const scopeId = "user:test";
const layoutGeneration = "generation-1";
const indexes: CollectionIndexConfiguration = {
  notes: [
    {
      name: "by-title",
      fields: ["title"],
      mode: "equality",
    },
    {
      name: "by-rank",
      fields: ["rank"],
      mode: "range",
    },
  ],
};
const sign = (bytes: Uint8Array) =>
  createHmac("sha256", "write-context-test-key")
    .update(bytes)
    .digest("hex");
const address = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("client-assisted trie writes", () => {
  it("preserves protocol bytes and removes authoritative reads with full context", async () => {
    const initial = await fixture();
    const baselineStore = initial.store.clone();
    const assistedStore = initial.store.clone();
    const baseline = engine(baselineStore);
    const document = updatedDocument();

    baselineStore.resetMetrics();
    await baseline.put(collection, document.id, document);
    const baselineReads = baselineStore.reads;
    const baselineSnapshot = baselineStore.snapshot();

    assistedStore.resetMetrics();
    const result = await applyClientAssistedTrieWrite({
      store: assistedStore,
      addressNode: address,
      verifySignature: sign,
      scopeId,
      collection,
      layoutGeneration,
      document,
      context: initial.fullContext,
      indexConfiguration: indexes,
    });

    expect(result).toMatchObject({
      mode: "assisted",
      fallbackReason: null,
      contextHits: 8,
      authoritativeReadsDuringAttempt: 0,
      verifiedObjects: 6,
    });
    expect(assistedStore.reads).toBe(0);
    expect(baselineReads).toBe(8);
    expect(assistedStore.snapshot()).toEqual(
      baselineSnapshot,
    );
  });

  it("uses authoritative index reads when only the warm trie path is supplied", async () => {
    const initial = await fixture();
    const store = initial.store.clone();
    store.resetMetrics();

    const result = await applyClientAssistedTrieWrite({
      store,
      addressNode: address,
      verifySignature: sign,
      scopeId,
      collection,
      layoutGeneration,
      document: updatedDocument(),
      context: initial.treeContext,
      indexConfiguration: indexes,
    });

    expect(result).toMatchObject({
      mode: "assisted",
      contextHits: 4,
      authoritativeReadsDuringAttempt: 4,
      verifiedObjects: 4,
    });
    expect(store.reads).toBe(4);
  });

  it("falls back before candidate writes when the signed HEAD is tampered", async () => {
    const initial = await fixture();
    const store = initial.store.clone();
    const context = structuredClone(initial.fullContext);
    context.head.value.revision += 1;
    store.resetMetrics();

    const result = await applyClientAssistedTrieWrite({
      store,
      addressNode: address,
      verifySignature: sign,
      scopeId,
      collection,
      layoutGeneration,
      document: updatedDocument(),
      context,
      indexConfiguration: indexes,
    });

    expect(result).toMatchObject({
      mode: "fallback",
      fallbackReason: "invalid",
      contextHits: 0,
    });
    expect(store.reads).toBe(8);
    expect(store.writes).toBe(6);
  });

  it("rejects context signed with a browser-visible scope key", async () => {
    const initial = await fixture();
    const store = initial.store.clone();
    const forged = structuredClone(initial.fullContext);
    forged.signature = createHmac(
      "sha256",
      "browser-visible-scope-key",
    )
      .update(signedHeadPayload(forged))
      .digest("hex");
    store.resetMetrics();

    const result = await applyClientAssistedTrieWrite({
      store,
      addressNode: address,
      verifySignature: sign,
      scopeId,
      collection,
      layoutGeneration,
      document: updatedDocument(),
      context: forged,
      indexConfiguration: indexes,
    });

    expect(result).toMatchObject({
      mode: "fallback",
      fallbackReason: "invalid",
    });
    expect(store.reads).toBe(8);
  });

  it("falls back before candidate writes when an immutable object is tampered", async () => {
    const initial = await fixture();
    const store = initial.store.clone();
    const context = structuredClone(initial.fullContext);
    const leaf = context.objects.find(
      (object) =>
        typeof object.value === "object" &&
        object.value !== null &&
        !Array.isArray(object.value) &&
        object.value.kind === "leaf",
    );
    expect(leaf).toBeDefined();
    (leaf!.value as Record<string, JsonValue>).tampered =
      true;
    store.resetMetrics();

    const result = await applyClientAssistedTrieWrite({
      store,
      addressNode: address,
      verifySignature: sign,
      scopeId,
      collection,
      layoutGeneration,
      document: updatedDocument(),
      context,
      indexConfiguration: indexes,
    });

    expect(result).toMatchObject({
      mode: "fallback",
      fallbackReason: "invalid",
    });
    expect(store.reads).toBe(8);
    expect(store.writes).toBe(6);
  });

  it("falls back after a stale HEAD conflict without losing the concurrent write", async () => {
    const initial = await fixture();
    const store = initial.store.clone();
    const concurrent = engine(store);
    await concurrent.put(collection, "note-2", {
      id: "note-2",
      title: "Concurrent",
      rank: 2,
    });
    store.resetMetrics();

    const result = await applyClientAssistedTrieWrite({
      store,
      addressNode: address,
      verifySignature: sign,
      scopeId,
      collection,
      layoutGeneration,
      document: updatedDocument(),
      context: initial.fullContext,
      indexConfiguration: indexes,
    });

    expect(result).toMatchObject({
      mode: "fallback",
      fallbackReason: "stale",
      contextHits: 8,
      authoritativeReadsDuringAttempt: 0,
    });
    await expect(
      engine(store).get(collection, "note-2"),
    ).resolves.toMatchObject({
      title: "Concurrent",
    });
    await expect(
      engine(store).get(collection, "note-1"),
    ).resolves.toMatchObject({
      title: "Updated",
    });
  });

  it("falls back when context is expired or absent", async () => {
    const initial = await fixture();
    const expiredStore = initial.store.clone();
    const expired = structuredClone(initial.fullContext);
    expired.issuedAt = 1;
    expired.expiresAt = 2;
    expired.signature = sign(
      signedHeadPayload(expired),
    );

    await expect(
      applyClientAssistedTrieWrite({
        store: expiredStore,
        addressNode: address,
        verifySignature: sign,
        scopeId,
        collection,
        layoutGeneration,
        document: updatedDocument(),
        context: expired,
        indexConfiguration: indexes,
        now: 3,
      }),
    ).resolves.toMatchObject({
      mode: "fallback",
      fallbackReason: "expired",
    });

    await expect(
      applyClientAssistedTrieWrite({
        store: initial.store.clone(),
        addressNode: address,
        verifySignature: sign,
        scopeId,
        collection,
        layoutGeneration,
        document: updatedDocument(),
        indexConfiguration: indexes,
      }),
    ).resolves.toMatchObject({
      mode: "fallback",
      fallbackReason: "missing",
    });
  });
});

async function fixture(): Promise<{
  store: MemoryStore;
  fullContext: ClientTrieWriteContext;
  treeContext: ClientTrieWriteContext;
}> {
  const store = new MemoryStore();
  const database = engine(store);
  await database.putMany(collection, [
    {
      id: "note-1",
      title: "Original",
      rank: 1,
    },
    {
      id: "note-2",
      title: "Second",
      rank: 2,
    },
  ]);
  const bundle = await database.readBundle(
    collection,
    "note-1",
  );
  const headObject = bundle.objects.find(
    (object) => object.key === trieHeadKey(collection),
  );
  if (!headObject) {
    throw new Error("Fixture HEAD is missing");
  }
  const head = headObject.value as unknown as TrieHead;
  const treeObjects = bundle.objects
    .filter((object) => object !== headObject)
    .map((object) => ({
      key: object.key,
      value: structuredClone(object.value),
    }));
  const indexObjects = [];
  for (const [name, reference] of Object.entries(
    head.indexes ?? {},
  )) {
    const key = trieIndexKey(
      collection,
      name,
      reference.hash,
    );
    const object = await store.get(key);
    if (!object) {
      throw new Error(`Fixture index ${name} is missing`);
    }
    indexObjects.push({
      key,
      value: decodeJson<JsonValue>(object.bytes),
    });
  }
  const issuedAt = Date.now();
  const contextOptions = {
    scopeId,
    collection,
    layoutGeneration,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    head: {
      etag: headObject.etag,
      value: head,
    },
    sign,
  };
  return {
    store,
    fullContext: await issueClientTrieWriteContext({
      ...contextOptions,
      objects: [...treeObjects, ...indexObjects],
    }),
    treeContext: await issueClientTrieWriteContext({
      ...contextOptions,
      objects: treeObjects,
    }),
  };
}

function engine(store: ObjectStore) {
  return new ContentAddressedTrieEngine(
    store,
    40,
    address,
    false,
    indexes,
  );
}

function updatedDocument(): JsonDocument {
  return {
    id: "note-1",
    title: "Updated",
    rank: 3,
  };
}

function signedHeadPayload(
  context: ClientTrieWriteContext,
): Uint8Array {
  return encodeJson({
    version: 1,
    scopeId: context.scopeId,
    collection: context.collection,
    layoutGeneration: context.layoutGeneration,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    head: context.head as unknown as JsonValue,
  });
}

class MemoryStore implements ObjectStore {
  private objects = new Map<string, StoredObject>();
  private etag = 0;
  reads = 0;
  writes = 0;

  get(key: string): Promise<StoredObject | null> {
    this.reads += 1;
    const object = this.objects.get(key);
    return Promise.resolve(
      object
        ? {
            etag: object.etag,
            bytes: object.bytes.slice(),
          }
        : null,
    );
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ): Promise<{ etag: string }> {
    const current = this.objects.get(key);
    if (
      (conditions.ifNoneMatch && current) ||
      (conditions.ifMatch !== undefined &&
        current?.etag !== conditions.ifMatch)
    ) {
      return Promise.reject(
        new PreconditionFailedError(key),
      );
    }
    const etag = String(++this.etag);
    this.objects.set(key, {
      etag,
      bytes: bytes.slice(),
    });
    this.writes += 1;
    return Promise.resolve({ etag });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.objects.keys()].filter((key) =>
        key.startsWith(prefix),
      ),
    );
  }

  clone(): MemoryStore {
    const clone = new MemoryStore();
    clone.etag = this.etag;
    clone.objects = new Map(
      [...this.objects].map(([key, object]) => [
        key,
        {
          etag: object.etag,
          bytes: object.bytes.slice(),
        },
      ]),
    );
    return clone;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.objects]
        .sort(([left], [right]) =>
          left.localeCompare(right),
        )
        .map(([key, object]) => [
          key,
          Buffer.from(object.bytes).toString("base64"),
        ]),
    );
  }

  resetMetrics(): void {
    this.reads = 0;
    this.writes = 0;
  }
}
