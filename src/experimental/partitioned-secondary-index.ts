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
  type SecondaryIndexPlan,
  type SecondaryIndexReference,
} from "../secondary-index.js";
import {
  createDictionary,
  encodeJson,
} from "../shared-utils.js";
import {
  isTrieTombstone,
  type TrieStoredDocument,
} from "../trie-protocol.js";

export type ExperimentalPartitionedIndexRouting =
  | {
      kind: "hash-values";
      partitions: number;
    }
  | {
      kind: "range";
      boundaries: JsonPrimitive[];
    };

export type ExperimentalPartitionedIndexConfiguration =
  Record<
    string,
    Record<string, ExperimentalPartitionedIndexRouting>
  >;

export type ExperimentalPartitionedIndexShard = {
  partition: number;
  hash: string;
  entries: number;
  documents: number;
  decodedBytes: number;
};

export type ExperimentalPartitionedIndexManifest = {
  version: 2;
  definition: SecondaryIndexDefinition;
  routing: ExperimentalPartitionedIndexRouting;
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

export function experimentalPartitionRouting(
  configuration: ExperimentalPartitionedIndexConfiguration,
  collection: string,
  indexName: string,
): ExperimentalPartitionedIndexRouting | null {
  const value = configuration[collection]?.[indexName];
  return value ? validateRouting(value) : null;
}

export function experimentalPartitionCount(
  configuration: ExperimentalPartitionedIndexConfiguration,
  collection: string,
  indexName: string,
): number | null {
  const routing = experimentalPartitionRouting(
    configuration,
    collection,
    indexName,
  );
  return routing ? partitionCount(routing) : null;
}

export function experimentalIndexPartition(
  definition: SecondaryIndexDefinition,
  document: TrieStoredDocument | null,
  routing: ExperimentalPartitionedIndexRouting,
): number | null {
  if (!document || isTrieTombstone(document)) {
    return null;
  }
  const values = definition.fields.map(
    (field) => document[field],
  );
  if (!values.every(isJsonPrimitive)) {
    return null;
  }
  const primitives = values as JsonPrimitive[];
  if (routing.kind === "hash-values") {
    return hashPartition(
      JSON.stringify(primitives),
      routing.partitions,
    );
  }
  const value = primitives[0]!;
  for (
    let partition = 0;
    partition < routing.boundaries.length;
    partition += 1
  ) {
    if (
      comparePrimitive(
        value,
        routing.boundaries[partition],
      ) < 0
    ) {
      return partition;
    }
  }
  return routing.boundaries.length;
}

export async function buildExperimentalPartitionedIndex(
  definition: SecondaryIndexDefinition,
  documents: Iterable<TrieStoredDocument>,
  routing: ExperimentalPartitionedIndexRouting,
  address: (
    bytes: Uint8Array,
  ) => Promise<string> | string,
): Promise<ExperimentalPreparedPartitionedIndex> {
  const normalizedRouting = validateRoutingForDefinition(
    routing,
    definition,
  );
  const buckets = Array.from(
    { length: partitionCount(normalizedRouting) },
    () => [] as TrieStoredDocument[],
  );
  for (const document of documents) {
    const partition = experimentalIndexPartition(
      definition,
      document,
      normalizedRouting,
    );
    if (partition !== null) {
      buckets[partition]!.push(document);
    }
  }
  const objects: ExperimentalPreparedPartitionedIndex["objects"] =
    [];
  const shards: ExperimentalPartitionedIndexShard[] = [];
  for (
    let partition = 0;
    partition < buckets.length;
    partition += 1
  ) {
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
    shards.push(
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
    normalizedRouting,
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
  address: (
    bytes: Uint8Array,
  ) => Promise<string> | string,
): Promise<ExperimentalPreparedPartitionedIndex> {
  if (
    !secondaryIndexDefinitionsEqual(
      manifest.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental value-partitioned index ${definition.name} definition changed`,
    );
  }
  const changesByPartition = new Map<
    number,
    SecondaryIndexChange[]
  >();
  for (const change of changes) {
    if (change.previousDocument === undefined) {
      throw new Error(
        `Experimental value-partitioned index ${definition.name} requires the previous document`,
      );
    }
    const previousPartition =
      experimentalIndexPartition(
        definition,
        change.previousDocument,
        manifest.routing,
      );
    const nextPartition = experimentalIndexPartition(
      definition,
      change.document,
      manifest.routing,
    );
    if (previousPartition !== null) {
      appendChange(
        changesByPartition,
        previousPartition,
        {
          id: change.id,
          document:
            previousPartition === nextPartition
              ? change.document
              : null,
        },
      );
    }
    if (
      nextPartition !== null &&
      nextPartition !== previousPartition
    ) {
      appendChange(
        changesByPartition,
        nextPartition,
        {
          id: change.id,
          document: change.document,
        },
      );
    }
  }

  const current = new Map(
    manifest.shards.map((shard) => [
      shard.partition,
      shard,
    ]),
  );
  const objects: ExperimentalPreparedPartitionedIndex["objects"] =
    [];
  for (
    const [partition, partitionChanges] of
    changesByPartition
  ) {
    const currentShard = current.get(partition);
    const page = updateSecondaryIndexPage(
      currentShard
        ? await loadShard(currentShard)
        : null,
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
    manifest.routing,
    [...current.values()].sort(
      (left, right) =>
        left.partition - right.partition,
    ),
    objects,
    address,
  );
}

export function selectExperimentalPartitionedIndexShards<
  T extends { id: string },
>(
  manifest: ExperimentalPartitionedIndexManifest,
  plan: SecondaryIndexPlan<T>,
): ExperimentalPartitionedIndexShard[] {
  if (
    !secondaryIndexDefinitionsEqual(
      manifest.definition,
      plan.definition,
    )
  ) {
    throw new Error(
      "Experimental value-partitioned query plan does not match its manifest",
    );
  }
  if (manifest.routing.kind === "hash-values") {
    const values = plan.definition.fields.map((field) =>
      plan.comparisons.find(
        (comparison) =>
          comparison.field === field &&
          comparison.operator === "eq",
      )?.value,
    );
    if (!values.every(isJsonPrimitive)) {
      return manifest.shards;
    }
    const partition = hashPartition(
      JSON.stringify(values),
      manifest.routing.partitions,
    );
    return manifest.shards.filter(
      (shard) => shard.partition === partition,
    );
  }
  const boundaries = manifest.routing.boundaries;
  return manifest.shards.filter((shard) =>
    rangePartitionMayMatch(
      boundaries,
      shard.partition,
      plan.comparisons,
    ),
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
    value.version !== 2 ||
    typeof value.definition !== "object" ||
    value.definition === null ||
    Array.isArray(value.definition) ||
    typeof value.routing !== "object" ||
    value.routing === null ||
    Array.isArray(value.routing) ||
    !Number.isInteger(value.documents) ||
    !Array.isArray(value.shards)
  ) {
    throw new Error(
      "Experimental value-partitioned secondary index manifest is malformed",
    );
  }
  const definition = validateIndexConfiguration({
    collection: [
      value.definition as unknown as SecondaryIndexDefinition,
    ],
  }).collection![0]!;
  const routing = validateRoutingForDefinition(
    value.routing as unknown as ExperimentalPartitionedIndexRouting,
    definition,
  );
  const partitions = partitionCount(routing);
  const seen = new Set<number>();
  const shards = value.shards
    .map((candidate) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        throw new Error(
          "Experimental value-partitioned secondary index shard is malformed",
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
        decodedBytes >
          MAX_SECONDARY_INDEX_PAGE_BYTES
      ) {
        throw new Error(
          "Experimental value-partitioned secondary index shard is malformed",
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
    })
    .sort(
      (left, right) =>
        left.partition - right.partition,
    );
  if (
    value.documents !==
    shards.reduce(
      (total, shard) => total + shard.documents,
      0,
    )
  ) {
    throw new Error(
      "Experimental value-partitioned secondary index totals do not match its shards",
    );
  }
  if (
    shards.reduce(
      (total, shard) =>
        total + shard.decodedBytes,
      0,
    ) > MAX_SECONDARY_INDEX_PAGE_BYTES
  ) {
    throw new Error(
      `Experimental value-partitioned secondary index exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} aggregate decoded bytes`,
    );
  }
  return {
    version: 2,
    definition,
    routing,
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
  const metadata =
    experimentalPartitionedIndexReferenceFromJson(
      reference.experimentalPartitions as unknown as JsonValue,
    );
  const entries = metadata.shards.reduce(
    (total, shard) => total + shard.entries,
    0,
  );
  if (reference.entries !== entries) {
    throw new Error(
      "Experimental value-partitioned secondary index entry count does not match its collection head",
    );
  }
  if (
    !secondaryIndexDefinitionsEqual(
      metadata.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental value-partitioned index ${definition.name} definition changed`,
    );
  }
  const encoded = encodeJson(
    metadata as unknown as JsonValue,
  );
  if (
    reference.decodedBytes !== encoded.byteLength
  ) {
    throw new Error(
      "Experimental value-partitioned secondary index metadata size does not match its collection head",
    );
  }
  return {
    version: 2,
    definition: metadata.definition,
    routing: metadata.routing,
    partitions: partitionCount(metadata.routing),
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
        "Experimental value-partitioned index shard definition does not match its manifest",
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
            `Experimental value-partitioned index contains duplicate document ${id}`,
          );
        }
        merged.ids.add(id);
      }
      entries.set(key, merged);
    }
    if (projections) {
      for (
        const [id, projection] of
        Object.entries(page.projections ?? {})
      ) {
        if (Object.hasOwn(projections, id)) {
          throw new Error(
            `Experimental value-partitioned index contains duplicate projection ${id}`,
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
        compareTuples(
          left.values,
          right.values,
        ),
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
      (total, entry) =>
        total + entry.ids.length,
      0,
    ) !== shard.documents ||
    !secondaryIndexDefinitionsEqual(
      page.definition,
      definition,
    )
  ) {
    throw new Error(
      `Experimental value-partitioned index shard ${shard.partition} does not match its manifest`,
    );
  }
}

async function finishPreparedIndex(
  definition: SecondaryIndexDefinition,
  routing: ExperimentalPartitionedIndexRouting,
  shards: ExperimentalPartitionedIndexShard[],
  shardObjects: ExperimentalPreparedPartitionedIndex["objects"],
  address: (
    bytes: Uint8Array,
  ) => Promise<string> | string,
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
      `Experimental value-partitioned index ${definition.name} exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} aggregate decoded bytes`,
    );
  }
  const manifest: ExperimentalPartitionedIndexManifest = {
    version: 2,
    definition,
    routing,
    partitions: partitionCount(routing),
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
    version: 2 as const,
    definition,
    routing,
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
      `Experimental value-partitioned index manifest ${definition.name} exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} decoded bytes`,
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

function validateRoutingForDefinition(
  routing: ExperimentalPartitionedIndexRouting,
  definition: SecondaryIndexDefinition,
): ExperimentalPartitionedIndexRouting {
  const normalized = validateRouting(routing);
  if (
    (definition.mode === "equality" &&
      normalized.kind !== "hash-values") ||
    (definition.mode === "range" &&
      normalized.kind !== "range")
  ) {
    throw new Error(
      `Experimental routing does not match index mode for ${definition.name}`,
    );
  }
  return normalized;
}

function validateRouting(
  routing: ExperimentalPartitionedIndexRouting,
): ExperimentalPartitionedIndexRouting {
  if (
    routing.kind === "hash-values" &&
    Number.isInteger(routing.partitions) &&
    routing.partitions >= 2 &&
    routing.partitions <= 64 &&
    (routing.partitions &
      (routing.partitions - 1)) ===
      0
  ) {
    return {
      kind: "hash-values",
      partitions: routing.partitions,
    };
  }
  if (
    routing.kind === "range" &&
    Array.isArray(routing.boundaries) &&
    routing.boundaries.length >= 1 &&
    routing.boundaries.length < 64 &&
    routing.boundaries.every(isJsonPrimitive) &&
    routing.boundaries.every(
      (boundary, index) =>
        index === 0 ||
        comparePrimitive(
          routing.boundaries[index - 1],
          boundary,
        ) < 0,
    )
  ) {
    return {
      kind: "range",
      boundaries: [...routing.boundaries],
    };
  }
  throw new Error(
    "Experimental value-partition routing is malformed",
  );
}

function partitionCount(
  routing: ExperimentalPartitionedIndexRouting,
): number {
  return routing.kind === "hash-values"
    ? routing.partitions
    : routing.boundaries.length + 1;
}

function hashPartition(
  value: string,
  partitions: number,
): number {
  let hash = 0x811c9dc5;
  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & (partitions - 1);
}

function rangePartitionMayMatch<
  T extends { id: string },
>(
  boundaries: JsonPrimitive[],
  partition: number,
  comparisons: SecondaryIndexPlan<T>["comparisons"],
): boolean {
  const lower =
    partition === 0
      ? undefined
      : boundaries[partition - 1];
  const upper = boundaries[partition];
  return comparisons.every((comparison) => {
    if (!isJsonPrimitive(comparison.value)) {
      return true;
    }
    const expected = comparison.value;
    if (comparison.operator === "eq") {
      return (
        (lower === undefined ||
          comparePrimitive(expected, lower) >= 0) &&
        (upper === undefined ||
          comparePrimitive(expected, upper) < 0)
      );
    }
    if (
      comparison.operator === "lt" ||
      comparison.operator === "lte"
    ) {
      if (lower === undefined) {
        return true;
      }
      const comparisonToLower = comparePrimitive(
        lower,
        expected,
      );
      return comparison.operator === "lt"
        ? comparisonToLower < 0
        : comparisonToLower <= 0;
    }
    if (
      comparison.operator === "gt" ||
      comparison.operator === "gte"
    ) {
      return (
        upper === undefined ||
        comparePrimitive(upper, expected) > 0
      );
    }
    return true;
  });
}

function appendChange(
  changes: Map<number, SecondaryIndexChange[]>,
  partition: number,
  change: SecondaryIndexChange,
): void {
  const current = changes.get(partition) ?? [];
  current.push(change);
  changes.set(partition, current);
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
      (total, entry) =>
        total + entry.ids.length,
      0,
    ),
    decodedBytes: bytes.byteLength,
  };
}

function isJsonPrimitive(
  value: unknown,
): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" &&
      Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function compareTuples(
  left: JsonPrimitive[],
  right: JsonPrimitive[],
): number {
  const length = Math.max(
    left.length,
    right.length,
  );
  for (
    let index = 0;
    index < length;
    index += 1
  ) {
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
  if (
    typeof left === "number" &&
    typeof right === "number"
  ) {
    return left - right;
  }
  if (
    typeof left === "string" &&
    typeof right === "string"
  ) {
    return left.localeCompare(right);
  }
  if (
    typeof left === "boolean" &&
    typeof right === "boolean"
  ) {
    return Number(left) - Number(right);
  }
  return JSON.stringify(left).localeCompare(
    JSON.stringify(right),
  );
}
