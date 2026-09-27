import {
  BoundedReadError,
  type JsonValue,
  type ObjectStore,
} from "../core.js";
import {
  secondaryIndexDefinitionsEqual,
  secondaryIndexPageFromJson,
  type SecondaryIndexDefinition,
  type SecondaryIndexPage,
  type SecondaryIndexReference,
} from "../secondary-index.js";
import {
  decodeJson,
  encodeJson,
} from "../shared-utils.js";
import {
  snapshotHeadKey,
  snapshotIndexKey,
  type CollectionLayout,
  type SnapshotHead,
} from "../snapshot-protocol.js";
import {
  trieHeadKey,
  trieIndexKey,
  type TrieHead,
} from "../trie-protocol.js";
import {
  experimentalPartitionedIndexManifestFromReference,
  mergeExperimentalPartitionedIndexPages,
  validateExperimentalPartitionedIndexShard,
} from "./partitioned-secondary-index.js";

export const EXPERIMENTAL_INDEX_BUNDLE_MAX_OBJECTS = 9;
export const EXPERIMENTAL_INDEX_BUNDLE_MAX_DECODED_BYTES =
  4 * 1024 * 1024;

export type ExperimentalIndexBundleObject = {
  key: string;
  etag: string;
  value: JsonValue;
  decodedBytes: number;
};

export type ExperimentalPartitionedIndexBundle = {
  version: 1;
  collection: string;
  indexName: string;
  layout: CollectionLayout;
  revision: number;
  head: ExperimentalIndexBundleObject;
  objects: ExperimentalIndexBundleObject[];
  sourceObjects: number;
  sourceDecodedBytes: number;
};

export type ExperimentalEncodedIndexBundle = {
  bundle: ExperimentalPartitionedIndexBundle;
  bytes: Uint8Array;
};

export async function readExperimentalPartitionedIndexBundle(
  store: ObjectStore,
  layout: CollectionLayout,
  collection: string,
  definition: SecondaryIndexDefinition,
  limits: {
    maxObjects?: number;
    maxDecodedBytes?: number;
  } = {},
): Promise<ExperimentalEncodedIndexBundle> {
  const maxObjects =
    limits.maxObjects ??
    EXPERIMENTAL_INDEX_BUNDLE_MAX_OBJECTS;
  const maxDecodedBytes =
    limits.maxDecodedBytes ??
    EXPERIMENTAL_INDEX_BUNDLE_MAX_DECODED_BYTES;
  const headKey =
    layout === "snapshot"
      ? snapshotHeadKey(collection)
      : trieHeadKey(collection);
  const headObject = await store.get(headKey);
  if (!headObject) {
    throw new Error(
      `Experimental index bundle collection HEAD is missing: ${collection}`,
    );
  }
  const headValue = decodeJson<JsonValue>(headObject.bytes);
  const head =
    layout === "snapshot"
      ? headValue as unknown as SnapshotHead
      : headValue as unknown as TrieHead;
  const reference = head.indexes?.[definition.name];
  if (!reference) {
    throw new Error(
      `Experimental index bundle is missing index ${definition.name}`,
    );
  }
  const manifest =
    experimentalPartitionedIndexManifestFromReference(
      reference,
      definition,
    );
  const sourceObjects = 1 + (manifest?.shards.length ?? 1);
  const expectedDecodedBytes =
    headObject.bytes.byteLength +
    (manifest
      ? manifest.shards.reduce(
          (total, shard) => total + shard.decodedBytes,
          0,
        )
      : reference.decodedBytes ?? maxDecodedBytes + 1);
  if (sourceObjects > maxObjects) {
    throw new BoundedReadError(
      `Experimental index bundle exceeds ${maxObjects} objects`,
    );
  }
  if (expectedDecodedBytes > maxDecodedBytes) {
    throw new BoundedReadError(
      `Experimental index bundle sources exceed ${maxDecodedBytes} decoded bytes`,
    );
  }

  const objects = manifest
    ? await Promise.all(
        manifest.shards.map(async (shard) => {
          const key = indexKey(
            layout,
            collection,
            definition.name,
            shard.hash,
          );
          const object = await store.get(key);
          if (!object) {
            throw new Error(
              `Experimental index bundle shard is missing: ${definition.name}/${shard.partition}`,
            );
          }
          if (object.bytes.byteLength !== shard.decodedBytes) {
            throw new Error(
              `Experimental index bundle shard size does not match: ${definition.name}/${shard.partition}`,
            );
          }
          const value = decodeJson<JsonValue>(object.bytes);
          validateExperimentalPartitionedIndexShard(
            shard,
            secondaryIndexPageFromJson(value),
            object.bytes.byteLength,
            definition,
          );
          return {
            key,
            etag: object.etag,
            value,
            decodedBytes: object.bytes.byteLength,
          };
        }),
      )
    : [
        await readMonolithicIndexObject(
          store,
          layout,
          collection,
          definition,
          reference,
        ),
      ];
  const sourceDecodedBytes =
    headObject.bytes.byteLength +
    objects.reduce(
      (total, object) => total + object.decodedBytes,
      0,
    );
  const bundle: ExperimentalPartitionedIndexBundle = {
    version: 1,
    collection,
    indexName: definition.name,
    layout,
    revision: head.revision,
    head: {
      key: headKey,
      etag: headObject.etag,
      value: headValue,
      decodedBytes: headObject.bytes.byteLength,
    },
    objects,
    sourceObjects,
    sourceDecodedBytes,
  };
  const bytes = encodeJson(bundle as unknown as JsonValue);
  if (bytes.byteLength > maxDecodedBytes) {
    throw new BoundedReadError(
      `Experimental index bundle response exceeds ${maxDecodedBytes} decoded bytes`,
    );
  }
  return { bundle, bytes };
}

export function pageFromExperimentalPartitionedIndexBundle(
  bundle: ExperimentalPartitionedIndexBundle,
  definition: SecondaryIndexDefinition,
): SecondaryIndexPage {
  if (
    bundle.version !== 1 ||
    bundle.indexName !== definition.name ||
    bundle.head.decodedBytes !==
      encodeJson(bundle.head.value).byteLength
  ) {
    throw new Error(
      "Experimental index bundle metadata is malformed",
    );
  }
  const head =
    bundle.layout === "snapshot"
      ? bundle.head.value as unknown as SnapshotHead
      : bundle.head.value as unknown as TrieHead;
  if (head.revision !== bundle.revision) {
    throw new Error(
      "Experimental index bundle revision does not match its HEAD",
    );
  }
  const reference = head.indexes?.[definition.name];
  if (!reference) {
    throw new Error(
      `Experimental index bundle HEAD is missing ${definition.name}`,
    );
  }
  const manifest =
    experimentalPartitionedIndexManifestFromReference(
      reference,
      definition,
    );
  if (!manifest) {
    if (bundle.objects.length !== 1) {
      throw new Error(
        "Experimental monolithic index bundle has the wrong object count",
      );
    }
    const object = bundle.objects[0]!;
    if (
      object.key !==
        indexKey(
          bundle.layout,
          bundle.collection,
          definition.name,
          reference.hash,
        ) ||
      object.decodedBytes !== reference.decodedBytes ||
      object.decodedBytes !== encodeJson(object.value).byteLength
    ) {
      throw new Error(
        "Experimental monolithic index bundle object does not match its HEAD",
      );
    }
    const page = secondaryIndexPageFromJson(object.value);
    if (
      page.entries.length !== reference.entries ||
      !secondaryIndexDefinitionsEqual(
        page.definition,
        definition,
      )
    ) {
      throw new Error(
        "Experimental monolithic index bundle page is invalid",
      );
    }
    return page;
  }
  if (bundle.objects.length !== manifest.shards.length) {
    throw new Error(
      "Experimental partitioned index bundle has the wrong object count",
    );
  }
  const byKey = new Map(
    bundle.objects.map((object) => [
      object.key,
      object,
    ]),
  );
  const pages = manifest.shards.map((shard) => {
    const key = indexKey(
      bundle.layout,
      bundle.collection,
      definition.name,
      shard.hash,
    );
    const object = byKey.get(key);
    if (
      !object ||
      object.decodedBytes !== shard.decodedBytes ||
      object.decodedBytes !== encodeJson(object.value).byteLength
    ) {
      throw new Error(
        `Experimental partitioned index bundle is missing shard ${shard.partition}`,
      );
    }
    const page = secondaryIndexPageFromJson(object.value);
    validateExperimentalPartitionedIndexShard(
      shard,
      page,
      object.decodedBytes,
      definition,
    );
    return page;
  });
  return mergeExperimentalPartitionedIndexPages(
    manifest,
    pages,
  );
}

async function readMonolithicIndexObject(
  store: ObjectStore,
  layout: CollectionLayout,
  collection: string,
  definition: SecondaryIndexDefinition,
  reference: SecondaryIndexReference,
): Promise<ExperimentalIndexBundleObject> {
  const key = indexKey(
    layout,
    collection,
    definition.name,
    reference.hash,
  );
  const object = await store.get(key);
  if (!object) {
    throw new Error(
      `Experimental index bundle page is missing: ${definition.name}`,
    );
  }
  if (object.bytes.byteLength !== reference.decodedBytes) {
    throw new Error(
      `Experimental index bundle page size does not match ${definition.name}`,
    );
  }
  const value = decodeJson<JsonValue>(object.bytes);
  const page = secondaryIndexPageFromJson(value);
  if (
    page.entries.length !== reference.entries ||
    !secondaryIndexDefinitionsEqual(
      page.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental index bundle page does not match ${definition.name}`,
    );
  }
  return {
    key,
    etag: object.etag,
    value,
    decodedBytes: object.bytes.byteLength,
  };
}

function indexKey(
  layout: CollectionLayout,
  collection: string,
  indexName: string,
  hash: string,
): string {
  return layout === "snapshot"
    ? snapshotIndexKey(collection, indexName, hash)
    : trieIndexKey(collection, indexName, hash);
}
