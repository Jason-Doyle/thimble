import type {
  JsonValue,
  ObjectStore,
} from "../../src/core.js";
import { ContentAddressedTrieEngine } from "../../src/engines/content-trie.js";
import {
  issueClientTrieWriteContext,
  type ClientTrieWriteContext,
  type ClientWriteContextSigner,
} from "../../src/experimental/client-write-context.js";
import type {
  CollectionIndexConfiguration,
} from "../../src/secondary-index.js";
import { decodeJson } from "../../src/shared-utils.js";
import {
  trieHeadKey,
  trieIndexKey,
  type TrieHead,
} from "../../src/trie-protocol.js";

export async function captureClientTrieWriteContext(
  options: {
    store: ObjectStore;
    addressNode: (
      bytes: Uint8Array,
    ) => Promise<string> | string;
    sign: ClientWriteContextSigner;
    scopeId: string;
    collection: string;
    documentId: string;
    layoutGeneration: string;
    indexConfiguration: CollectionIndexConfiguration;
    includeIndexes: boolean;
    now?: number;
  },
): Promise<{
  context: ClientTrieWriteContext;
  requestBytes: number;
}> {
  const engine = new ContentAddressedTrieEngine(
    options.store,
    40,
    options.addressNode,
    false,
    options.indexConfiguration,
  );
  const bundle = await engine.readBundle(
    options.collection,
    options.documentId,
  );
  const headKey = trieHeadKey(options.collection);
  const headObject = bundle.objects.find(
    (object) => object.key === headKey,
  );
  if (!headObject) {
    throw new Error(
      "Client write context requires an existing HEAD",
    );
  }
  const head = headObject.value as unknown as TrieHead;
  const objects = bundle.objects
    .filter((object) => object.key !== headKey)
    .map((object) => ({
      key: object.key,
      value: structuredClone(object.value),
    }));
  if (options.includeIndexes) {
    for (const [name, reference] of Object.entries(
      head.indexes ?? {},
    )) {
      const key = trieIndexKey(
        options.collection,
        name,
        reference.hash,
      );
      const object = await options.store.get(key);
      if (!object) {
        throw new Error(
          `Client write context index ${name} is missing`,
        );
      }
      objects.push({
        key,
        value: decodeJson<JsonValue>(object.bytes),
      });
    }
  }
  const now = options.now ?? Date.now();
  const context = await issueClientTrieWriteContext({
    scopeId: options.scopeId,
    collection: options.collection,
    layoutGeneration: options.layoutGeneration,
    issuedAt: now,
    expiresAt: now + 60_000,
    head: {
      etag: headObject.etag,
      value: head,
    },
    objects,
    sign: options.sign,
  });
  return {
    context,
    requestBytes: new TextEncoder().encode(
      JSON.stringify(context),
    ).byteLength,
  };
}
