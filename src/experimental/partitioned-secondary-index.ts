import type {
  JsonDocument,
  JsonPrimitive,
  JsonValue,
} from "../core.js";
import {
  buildSecondaryIndexPage,
  encodeSecondaryIndexPage,
  MAX_SECONDARY_INDEX_PAGE_BYTES,
  secondaryIndexDefinitionsEqual,
  secondaryIndexPageFromJson,
  updateSecondaryIndexPage,
  validateIndexConfiguration,
  type SecondaryIndexChange,
  type SecondaryIndexDefinition,
  type SecondaryIndexPage,
  type SecondaryIndexReference,
} from "../secondary-index.js";
import {
  createDictionary,
  encodeJson,
} from "../shared-utils.js";
import type {
  TrieStoredDocument,
} from "../trie-protocol.js";

export type ExperimentalPartitionedIndexConfiguration =
  Record<string, Record<string, number>>;

export type ExperimentalPartitionedIndexShard = {
  partition: number;
  hash: string;
  entries: number;
  documents: number;
  decodedBytes: number;
};

export type ExperimentalPartitionedIndexManifest = {
  version: 1;
  definition: SecondaryIndexDefinition;
  partitions: number;
  entries: number;
  documents: number;
  shards: ExperimentalPartitionedIndexShard[];
};

export type ExperimentalPreparedPartitionedIndex = {
  manifest: ExperimentalPartitionedIndexManifest;
  reference: SecondaryIndexReference;
  objects: Array<{
    hash: string;
    bytes: Uint8Array;
  }>;
};

export function experimentalPartitionCount(
  configuration: ExperimentalPartitionedIndexConfiguration,
  collection: string,
  indexName: string,
): number | null {
  const value = configuration[collection]?.[indexName];
  if (value === undefined) {
    return null;
  }
  if (
    !Number.isInteger(value) ||
    value < 2 ||
    value > 64 ||
    (value & (value - 1)) !== 0
  ) {
    throw new Error(
      `Experimental partition count for ${collection}/${indexName} must be a power of two from 2 to 64`,
    );
  }
  return value;
}

export function experimentalIndexPartition(
  id: string,
  partitions: number,
): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & (partitions - 1);
}

export async function buildExperimentalPartitionedIndex(
  definition: SecondaryIndexDefinition,
  documents: Iterable<TrieStoredDocument>,
  partitions: number,
  address: (bytes: Uint8Array) => Promise<string> | string,
): Promise<ExperimentalPreparedPartitionedIndex> {
  validatePartitionCount(partitions);
  const buckets = Array.from(
    { length: partitions },
    () => [] as TrieStoredDocument[],
  );
  for (const document of documents) {
    buckets[
      experimentalIndexPartition(document.id, partitions)
    ]!.push(document);
  }
  const objects: ExperimentalPreparedPartitionedIndex["objects"] = [];
  const shards: ExperimentalPartitionedIndexShard[] = [];
  for (let partition = 0; partition < buckets.length; partition += 1) {
    const page = buildSecondaryIndexPage(
      definition,
      buckets[partition]!,
    );
    if (page.entries.length === 0) {
      continue;
    }
    const bytes = encodeSecondaryIndexPage(page);
    const hash = await address(bytes);
    objects.push({ hash, bytes });
    shards.push(shardReference(partition, hash, page, bytes));
  }
  return finishPreparedIndex(
    definition,
    partitions,
    shards,
    objects,
    address,
  );
}

export async function updateExperimentalPartitionedIndex(
  manifest: ExperimentalPartitionedIndexManifest,
  definition: SecondaryIndexDefinition,
  changes: SecondaryIndexChange[],
  loadShard: (
    shard: ExperimentalPartitionedIndexShard,
  ) => Promise<SecondaryIndexPage>,
  address: (bytes: Uint8Array) => Promise<string> | string,
): Promise<ExperimentalPreparedPartitionedIndex> {
  if (
    !secondaryIndexDefinitionsEqual(
      manifest.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental partitioned index ${definition.name} definition changed`,
    );
  }
  const changesByPartition = new Map<
    number,
    SecondaryIndexChange[]
  >();
  for (const change of changes) {
    const partition = experimentalIndexPartition(
      change.id,
      manifest.partitions,
    );
    const partitionChanges =
      changesByPartition.get(partition) ?? [];
    partitionChanges.push(change);
    changesByPartition.set(partition, partitionChanges);
  }
  const current = new Map(
    manifest.shards.map((shard) => [
      shard.partition,
      shard,
    ]),
  );
  const objects: ExperimentalPreparedPartitionedIndex["objects"] = [];
  for (const [partition, partitionChanges] of changesByPartition) {
    const currentShard = current.get(partition);
    const page = updateSecondaryIndexPage(
      currentShard ? await loadShard(currentShard) : null,
      definition,
      partitionChanges,
    );
    if (page.entries.length === 0) {
      current.delete(partition);
      continue;
    }
    const bytes = encodeSecondaryIndexPage(page);
    const hash = await address(bytes);
    objects.push({ hash, bytes });
    current.set(
      partition,
      shardReference(
        partition,
        hash,
        page,
        bytes,
      ),
    );
  }
  return finishPreparedIndex(
    definition,
    manifest.partitions,
    [...current.values()].sort(
      (left, right) => left.partition - right.partition,
    ),
    objects,
    address,
  );
}

export function experimentalPartitionedIndexReferenceFromJson(
  value: JsonValue,
): NonNullable<
  SecondaryIndexReference["experimentalPartitions"]
> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.version !== 1 ||
    typeof value.definition !== "object" ||
    value.definition === null ||
    Array.isArray(value.definition) ||
    !Number.isInteger(value.partitions) ||
    !Number.isInteger(value.documents) ||
    !Array.isArray(value.shards)
  ) {
    throw new Error(
      "Experimental partitioned secondary index manifest is malformed",
    );
  }
  const partitions = value.partitions as number;
  validatePartitionCount(partitions);
  const definition = validateIndexConfiguration({
    collection: [
      value.definition as unknown as SecondaryIndexDefinition,
    ],
  }).collection![0]!;
  const seen = new Set<number>();
  const shards = value.shards.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error(
        "Experimental partitioned secondary index shard is malformed",
      );
    }
    const partition = candidate.partition;
    const entries = candidate.entries;
    const documents = candidate.documents;
    const decodedBytes = candidate.decodedBytes;
    if (
      typeof partition !== "number" ||
      !Number.isInteger(partition) ||
      partition < 0 ||
      partition >= partitions ||
      seen.has(partition) ||
      typeof candidate.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.hash) ||
      typeof entries !== "number" ||
      !Number.isInteger(entries) ||
      entries < 1 ||
      typeof documents !== "number" ||
      !Number.isInteger(documents) ||
      documents < 1 ||
      typeof decodedBytes !== "number" ||
      !Number.isInteger(decodedBytes) ||
      decodedBytes < 1 ||
      decodedBytes > MAX_SECONDARY_INDEX_PAGE_BYTES
    ) {
      throw new Error(
        "Experimental partitioned secondary index shard is malformed",
      );
    }
    seen.add(partition);
    return {
      partition,
      hash: candidate.hash,
      entries,
      documents,
      decodedBytes,
    };
  }).sort((left, right) => left.partition - right.partition);
  if (
    value.documents !==
      shards.reduce(
        (total, shard) => total + shard.documents,
        0,
      )
  ) {
    throw new Error(
      "Experimental partitioned secondary index totals do not match its shards",
    );
  }
  if (
    shards.reduce(
      (total, shard) => total + shard.decodedBytes,
      0,
    ) > MAX_SECONDARY_INDEX_PAGE_BYTES
  ) {
    throw new Error(
      `Experimental partitioned secondary index exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} aggregate decoded bytes`,
    );
  }
  return {
    version: 1,
    definition,
    partitions,
    documents: value.documents as number,
    shards,
  };
}

export function experimentalPartitionedIndexManifestFromReference(
  reference: SecondaryIndexReference,
  definition: SecondaryIndexDefinition,
): ExperimentalPartitionedIndexManifest | null {
  if (!reference.experimentalPartitions) {
    return null;
  }
  const metadata = experimentalPartitionedIndexReferenceFromJson(
    reference.experimentalPartitions as unknown as JsonValue,
  );
  const entries = metadata.shards.reduce(
    (total, shard) => total + shard.entries,
    0,
  );
  if (reference.entries !== entries) {
    throw new Error(
      "Experimental partitioned secondary index entry count does not match its collection head",
    );
  }
  if (
    !secondaryIndexDefinitionsEqual(
      metadata.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental partitioned index ${definition.name} definition changed`,
    );
  }
  const encoded = encodeJson(
    metadata as unknown as JsonValue,
  );
  if (reference.decodedBytes !== encoded.byteLength) {
    throw new Error(
      "Experimental partitioned secondary index metadata size does not match its collection head",
    );
  }
  return {
    version: 1,
    definition: metadata.definition,
    partitions: metadata.partitions,
    entries,
    documents: metadata.documents,
    shards: metadata.shards,
  };
}

export function mergeExperimentalPartitionedIndexPages(
  manifest: ExperimentalPartitionedIndexManifest,
  pages: SecondaryIndexPage[],
): SecondaryIndexPage {
  const entries = new Map<
    string,
    {
      values: JsonPrimitive[];
      ids: Set<string>;
    }
  >();
  const projections = manifest.definition.include
    ? createDictionary<JsonDocument>()
    : undefined;
  for (const page of pages) {
    if (
      !secondaryIndexDefinitionsEqual(
        page.definition,
        manifest.definition,
      )
    ) {
      throw new Error(
        "Experimental partitioned index shard definition does not match its manifest",
      );
    }
    for (const entry of page.entries) {
      const key = JSON.stringify(entry.values);
      const merged = entries.get(key) ?? {
        values: [...entry.values],
        ids: new Set<string>(),
      };
      for (const id of entry.ids) {
        if (merged.ids.has(id)) {
          throw new Error(
            `Experimental partitioned index contains duplicate document ${id}`,
          );
        }
        merged.ids.add(id);
      }
      entries.set(key, merged);
    }
    if (projections) {
      for (const [id, projection] of Object.entries(
        page.projections ?? {},
      )) {
        if (Object.hasOwn(projections, id)) {
          throw new Error(
            `Experimental partitioned index contains duplicate projection ${id}`,
          );
        }
        projections[id] = projection;
      }
    }
  }
  const value = {
    version: 1,
    definition: manifest.definition,
    entries: [...entries.values()]
      .map((entry) => ({
        values: entry.values,
        ids: [...entry.ids].sort(),
      }))
      .sort((left, right) =>
        compareTuples(left.values, right.values),
      ),
    ...(projections ? { projections } : {}),
  } as unknown as JsonValue;
  return secondaryIndexPageFromJson(value);
}

export function validateExperimentalPartitionedIndexShard(
  shard: ExperimentalPartitionedIndexShard,
  page: SecondaryIndexPage,
  decodedBytes: number,
  definition: SecondaryIndexDefinition,
): void {
  if (
    decodedBytes !== shard.decodedBytes ||
    page.entries.length !== shard.entries ||
    page.entries.reduce(
      (total, entry) => total + entry.ids.length,
      0,
    ) !== shard.documents ||
    !secondaryIndexDefinitionsEqual(
      page.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental partitioned index shard ${shard.partition} does not match its manifest`,
    );
  }
}

async function finishPreparedIndex(
  definition: SecondaryIndexDefinition,
  partitions: number,
  shards: ExperimentalPartitionedIndexShard[],
  shardObjects: ExperimentalPreparedPartitionedIndex["objects"],
  address: (bytes: Uint8Array) => Promise<string> | string,
): Promise<ExperimentalPreparedPartitionedIndex> {
  const aggregateDecodedBytes = shards.reduce(
    (total, shard) => total + shard.decodedBytes,
    0,
  );
  if (
    aggregateDecodedBytes >
    MAX_SECONDARY_INDEX_PAGE_BYTES
  ) {
    throw new Error(
      `Experimental partitioned index ${definition.name} exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} aggregate decoded bytes`,
    );
  }
  const manifest: ExperimentalPartitionedIndexManifest = {
    version: 1,
    definition,
    partitions,
    entries: shards.reduce(
      (total, shard) => total + shard.entries,
      0,
    ),
    documents: shards.reduce(
      (total, shard) => total + shard.documents,
      0,
    ),
    shards,
  };
  const metadata = {
    version: 1 as const,
    definition,
    partitions,
    documents: manifest.documents,
    shards,
  };
  const metadataBytes = encodeJson(
    metadata as unknown as JsonValue,
  );
  if (
    metadataBytes.byteLength >
    MAX_SECONDARY_INDEX_PAGE_BYTES
  ) {
    throw new Error(
      `Experimental partitioned index manifest ${definition.name} exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} decoded bytes`,
    );
  }
  const hash = await address(metadataBytes);
  return {
    manifest,
    reference: {
      hash,
      entries: manifest.entries,
      decodedBytes: metadataBytes.byteLength,
      experimentalPartitions: metadata,
    },
    objects: shardObjects,
  };
}

function shardReference(
  partition: number,
  hash: string,
  page: SecondaryIndexPage,
  bytes: Uint8Array,
): ExperimentalPartitionedIndexShard {
  return {
    partition,
    hash,
    entries: page.entries.length,
    documents: page.entries.reduce(
      (total, entry) => total + entry.ids.length,
      0,
    ),
    decodedBytes: bytes.byteLength,
  };
}

function validatePartitionCount(partitions: number): void {
  if (
    !Number.isInteger(partitions) ||
    partitions < 2 ||
    partitions > 64 ||
    (partitions & (partitions - 1)) !== 0
  ) {
    throw new Error(
      "Experimental partition count must be a power of two from 2 to 64",
    );
  }
}

function compareTuples(
  left: JsonPrimitive[],
  right: JsonPrimitive[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = comparePrimitive(
      left[index],
      right[index],
    );
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function comparePrimitive(
  left: JsonPrimitive | undefined,
  right: JsonPrimitive | undefined,
): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return -1;
  }
  if (right === undefined) {
    return 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
