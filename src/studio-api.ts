import {
  BoundedReadError,
  type JsonDocument,
  type JsonValue,
  type ObjectStore,
} from "./core.js";
import {
  ContentAddressedTrieEngine,
} from "./engines/content-trie.js";
import {
  ImmutableSnapshotEngine,
} from "./engines/immutable-snapshot.js";
import {
  createArchiveCollection,
  type ArchiveCollection,
} from "./migration/archive.js";
import {
  buildSecondaryIndexPage,
  secondaryIndexDefinitionsEqual,
  secondaryIndexPageFromJson,
  type CollectionIndexConfiguration,
  type SecondaryIndexDefinition,
  type SecondaryIndexReference,
} from "./secondary-index.js";
import {
  decodeJson,
  encodeJson,
  stableStringify,
  validateName,
} from "./shared-utils.js";
import {
  snapshotHeadKey,
  snapshotIndexKey,
  type CollectionLayout,
  type SnapshotHead,
} from "./snapshot-protocol.js";
import {
  isTrieTombstone,
  trieHeadKey,
  trieIndexKey,
  type TrieHead,
  type TrieStoredDocument,
} from "./trie-protocol.js";
import type { ScopeGrant } from "./auth/types.js";

export const STUDIO_API_VERSION = 1;
export const STUDIO_MAX_DELETED_DOCUMENTS = 1_000;
export const STUDIO_MAX_EXPORT_DOCUMENTS = 10_000;
export const STUDIO_MAX_EXPORT_BYTES = 16 * 1024 * 1024;
export const STUDIO_COLLECTION_PAGE_SIZE = 20;
export const STUDIO_MAX_INDEXES_PER_COLLECTION = 32;
export const STUDIO_MAX_INDEX_PAGE_BYTES = 4 * 1024 * 1024;
export const STUDIO_MAX_INDEX_TOTAL_BYTES = 32 * 1024 * 1024;

export class StudioLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioLimitError";
  }
}

export type StudioScopeSummary = {
  id: string;
  permissions: ScopeGrant["permissions"];
};

export type StudioIndexHealth = {
  definition: SecondaryIndexDefinition;
  active: boolean;
  entries: number | null;
  status:
    | "active"
    | "ready"
    | "empty"
    | "missing"
    | "mismatch"
    | "unknown"
    | "oversized";
};

export type StudioCollectionSummary = {
  name: string;
  layout: CollectionLayout;
  revision: number;
  hasData: boolean;
  indexes: StudioIndexHealth[];
  unexpectedIndexes: string[];
  retiredLayouts: CollectionLayout[];
};

export type StudioDeletedDocument = {
  id: string;
  deletedAt: string;
  restoreUntil: string;
  purgeAfter: string;
  document: JsonDocument;
};

export type StudioScopeRuntime = {
  store: ObjectStore;
  trie: ContentAddressedTrieEngine;
  snapshot: ImmutableSnapshotEngine;
};

export function studioScopes(
  grants: ScopeGrant[],
): StudioScopeSummary[] {
  return grants.map((grant) => ({
    id: grant.scopeId,
    permissions: [...grant.permissions],
  }));
}

export function studioCollectionCatalog(options: {
  collections?: string[];
  collectionLayouts: Record<string, CollectionLayout>;
  collectionIndexes: CollectionIndexConfiguration;
}): string[] {
  const names = new Set([
    ...(options.collections ?? []),
    ...Object.keys(options.collectionLayouts),
    ...Object.keys(options.collectionIndexes),
  ]);
  if (names.size > 1_000) {
    throw new Error(
      "Studio collection catalog cannot contain more than 1000 collections",
    );
  }
  return [...names]
    .map((name) => validateName(name, "Collection"))
    .sort((left, right) => left.localeCompare(right));
}

export async function discoverStudioCollections(options: {
  runtime: StudioScopeRuntime;
  collections: string[];
  collectionLayouts: Record<string, CollectionLayout>;
  collectionIndexes: CollectionIndexConfiguration;
  offset?: number;
  limit?: number;
}): Promise<{
  collections: StudioCollectionSummary[];
  total: number;
  nextOffset: number | null;
}> {
  const names = new Set([
    ...options.collections,
    ...Object.keys(options.collectionLayouts),
    ...Object.keys(options.collectionIndexes),
  ]);
  const ordered = [...names].sort((left, right) =>
    left.localeCompare(right),
  );
  const offset = options.offset ?? 0;
  const limit = Math.min(
    options.limit ?? STUDIO_COLLECTION_PAGE_SIZE,
    STUDIO_COLLECTION_PAGE_SIZE,
  );
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    throw new Error("Studio collection page is invalid");
  }
  const pageNames = ordered.slice(offset, offset + limit);
  for (const name of pageNames) {
    if (
      (options.collectionIndexes[name]?.length ?? 0) >
      STUDIO_MAX_INDEXES_PER_COLLECTION
    ) {
      throw new StudioLimitError(
        `Studio index health supports at most ${STUDIO_MAX_INDEXES_PER_COLLECTION} indexes per collection`,
      );
    }
  }
  const collections = await Promise.all(
    pageNames.map((name) =>
        studioCollectionSummary({
          ...options,
          name,
        }),
      ),
  );
  const next = offset + collections.length;
  return {
    collections,
    total: ordered.length,
    nextOffset: next < ordered.length ? next : null,
  };
}

export async function studioDeletedDocuments(options: {
  engine:
    | ContentAddressedTrieEngine
    | ImmutableSnapshotEngine;
  collection: string;
  maximum?: number;
}): Promise<StudioDeletedDocument[]> {
  const collection = validateName(
    options.collection,
    "Collection",
  );
  const stored = await boundedStoredDocuments(
    options.engine,
    collection,
    STUDIO_MAX_EXPORT_DOCUMENTS,
    options.maximum ?? STUDIO_MAX_DELETED_DOCUMENTS,
  );
  const deleted = stored.filter(isTrieTombstone);
  const maximum =
    options.maximum ?? STUDIO_MAX_DELETED_DOCUMENTS;
  if (deleted.length > maximum) {
    throw new StudioLimitError(
      `Studio deleted-document listing contains ${deleted.length} records, above the maximum of ${maximum}`,
    );
  }
  return deleted
    .map((record) => ({
      id: record.id,
      deletedAt: record.__thimbleTombstone.deletedAt,
      restoreUntil: record.__thimbleTombstone.restoreUntil,
      purgeAfter: record.__thimbleTombstone.purgeAfter,
      document: record.document,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function studioCollectionExport(options: {
  engine:
    | ContentAddressedTrieEngine
    | ImmutableSnapshotEngine;
  scopeId: string;
  collection: string;
  maximum?: number;
}): Promise<{
  manifest: ArchiveCollection;
  ndjson: string;
}> {
  const collection = validateName(
    options.collection,
    "Collection",
  );
  const stored = await boundedStoredDocuments(
    options.engine,
    collection,
    options.maximum ?? STUDIO_MAX_EXPORT_DOCUMENTS,
  );
  const documents = stored.filter(
    (document): document is JsonDocument =>
      !isTrieTombstone(document),
  );
  const maximum =
    options.maximum ?? STUDIO_MAX_EXPORT_DOCUMENTS;
  if (documents.length > maximum) {
    throw new StudioLimitError(
      `Studio export contains ${documents.length} documents, above the maximum of ${maximum}`,
    );
  }

  return createArchiveCollection(
    collection,
    `collections/${encodeURIComponent(options.scopeId)}--${encodeURIComponent(collection)}.ndjson`,
    documents as TrieStoredDocument[],
    false,
  );
}

async function boundedStoredDocuments(
  engine:
    | ContentAddressedTrieEngine
    | ImmutableSnapshotEngine,
  collection: string,
  maximum: number,
  maxTombstones?: number,
): Promise<TrieStoredDocument[]> {
  try {
    return await engine.exportStoredBounded(
      collection,
      maximum,
      STUDIO_MAX_EXPORT_BYTES,
      maxTombstones,
    );
  } catch (error) {
    if (error instanceof BoundedReadError) {
      throw new StudioLimitError(error.message);
    }
    throw error;
  }
}

export async function rebuildStudioIndexes(options: {
  runtime: StudioScopeRuntime;
  collection: string;
  layout: CollectionLayout;
  collectionIndexes: CollectionIndexConfiguration;
  addressNode(bytes: Uint8Array): Promise<string> | string;
}): Promise<{
  records: number;
  indexes: string[];
}> {
  const collection = validateName(
    options.collection,
    "Collection",
  );
  const source =
    options.layout === "snapshot"
      ? options.runtime.snapshot
      : options.runtime.trie;
  const stored = await boundedStoredDocuments(
    source,
    collection,
    STUDIO_MAX_EXPORT_DOCUMENTS,
    STUDIO_MAX_EXPORT_DOCUMENTS,
  );
  const definitions =
    options.collectionIndexes[collection] ?? [];
  if (definitions.length > STUDIO_MAX_INDEXES_PER_COLLECTION) {
    throw new StudioLimitError(
      `Studio index rebuild supports at most ${STUDIO_MAX_INDEXES_PER_COLLECTION} indexes per collection`,
    );
  }
  let aggregateIndexBytes = 0;
  for (const definition of definitions) {
    const page = buildSecondaryIndexPage(
      definition,
      stored,
    );
    const bytes = encodeJson(page as unknown as JsonValue);
    if (bytes.byteLength > STUDIO_MAX_INDEX_PAGE_BYTES) {
      throw new StudioLimitError(
        `Secondary index ${definition.name} exceeds ${STUDIO_MAX_INDEX_PAGE_BYTES} decoded bytes`,
      );
    }
    aggregateIndexBytes += bytes.byteLength;
    if (aggregateIndexBytes > STUDIO_MAX_INDEX_TOTAL_BYTES) {
      throw new StudioLimitError(
        `Secondary index rebuild exceeds ${STUDIO_MAX_INDEX_TOTAL_BYTES} aggregate decoded bytes`,
      );
    }
  }
  const rewriter =
    options.layout === "snapshot"
      ? new ImmutableSnapshotEngine(
          options.runtime.store,
          40,
          options.addressNode,
          false,
          options.collectionIndexes,
          true,
        )
      : new ContentAddressedTrieEngine(
          options.runtime.store,
          40,
          options.addressNode,
          false,
          options.collectionIndexes,
          true,
        );
  if (rewriter instanceof ContentAddressedTrieEngine) {
    await rewriter.rebuildIndexesFromStored(
      collection,
      stored,
    );
  } else {
    await rewriter.replaceStored(collection, stored);
  }
  const verified = await boundedStoredDocuments(
    rewriter,
    collection,
    STUDIO_MAX_EXPORT_DOCUMENTS,
    STUDIO_MAX_EXPORT_DOCUMENTS,
  );
  if (
    stableStringify(verified as unknown as JsonValue) !==
    stableStringify(stored as unknown as JsonValue)
  ) {
    throw new Error(
      `Collection ${collection} changed while rebuilding indexes`,
    );
  }
  return {
    records: stored.length,
    indexes: (
      definitions
    ).map((definition) => definition.name),
  };
}

async function studioCollectionSummary(options: {
  runtime: StudioScopeRuntime;
  collectionLayouts: Record<string, CollectionLayout>;
  collectionIndexes: CollectionIndexConfiguration;
  name: string;
}): Promise<StudioCollectionSummary> {
  const name = validateName(options.name, "Collection");
  const layout = options.collectionLayouts[name] ?? "trie";
  const configured = options.collectionIndexes[name] ?? [];
  const headObject = await options.runtime.store.get(
    layout === "snapshot"
      ? snapshotHeadKey(name)
      : trieHeadKey(name),
  );
  const retiredLayout: CollectionLayout =
    layout === "snapshot" ? "trie" : "snapshot";
  const retiredHeadObject = await options.runtime.store.get(
    retiredLayout === "snapshot"
      ? snapshotHeadKey(name)
      : trieHeadKey(name),
  );
  const head = headObject
    ? layout === "snapshot"
      ? decodeJson<SnapshotHead>(headObject.bytes)
      : decodeJson<TrieHead>(headObject.bytes)
    : layout === "snapshot"
      ? {
          revision: 0,
          snapshotHash: null,
        } satisfies SnapshotHead
      : {
          revision: 0,
          rootHash: null,
        } satisfies TrieHead;
  const references = head.indexes ?? {};
  const indexes = configured.map((definition) =>
    shallowStudioIndexHealth(
      definition,
      references[definition.name],
      head.revision,
    ),
  );
  const configuredNames = new Set(
    configured.map((definition) => definition.name),
  );
  const retiredLayouts: CollectionLayout[] =
    retiredHeadObject ? [retiredLayout] : [];
  return {
    name,
    layout,
    revision: head.revision,
    hasData:
      "snapshotHash" in head
        ? head.snapshotHash !== null
        : head.rootHash !== null,
    indexes,
    unexpectedIndexes: Object.keys(references)
      .filter((indexName) => !configuredNames.has(indexName))
      .sort(),
    retiredLayouts,
  };
}

export async function inspectStudioIndex(options: {
  runtime: StudioScopeRuntime;
  collection: string;
  layout: CollectionLayout;
  definition: SecondaryIndexDefinition;
}): Promise<StudioIndexHealth> {
  const collection = validateName(
    options.collection,
    "Collection",
  );
  const headObject = await options.runtime.store.get(
    options.layout === "snapshot"
      ? snapshotHeadKey(collection)
      : trieHeadKey(collection),
  );
  const head = headObject
    ? options.layout === "snapshot"
      ? decodeJson<SnapshotHead>(headObject.bytes)
      : decodeJson<TrieHead>(headObject.bytes)
    : options.layout === "snapshot"
      ? {
          revision: 0,
          snapshotHash: null,
        } satisfies SnapshotHead
      : {
          revision: 0,
          rootHash: null,
        } satisfies TrieHead;
  const reference = head.indexes?.[options.definition.name];
  const shallow = shallowStudioIndexHealth(
    options.definition,
    reference,
    head.revision,
  );
  if (!reference) {
    return shallow;
  }
  if (reference.decodedBytes === undefined) {
    return {
      ...shallow,
      status: "unknown",
    };
  }
  if (reference.decodedBytes > STUDIO_MAX_INDEX_PAGE_BYTES) {
    return {
      ...shallow,
      status: "oversized",
    };
  }
  const object = await options.runtime.store.get(
    options.layout === "snapshot"
      ? snapshotIndexKey(
          collection,
          options.definition.name,
          reference.hash,
        )
      : trieIndexKey(
          collection,
          options.definition.name,
          reference.hash,
        ),
  );
  if (!object) {
    return {
      definition: options.definition,
      active: true,
      entries: reference.entries,
      status: "missing",
    };
  }
  if (object.bytes.byteLength !== reference.decodedBytes) {
    return {
      definition: options.definition,
      active: true,
      entries: reference.entries,
      status: "mismatch",
    };
  }
  let matches = false;
  try {
    const page = secondaryIndexPageFromJson(
      decodeJson<JsonValue>(object.bytes),
    );
    matches =
      secondaryIndexDefinitionsEqual(
        page.definition,
        options.definition,
      ) &&
        page.entries.length === reference.entries;
  } catch {
    matches = false;
  }
  return {
    definition: options.definition,
    active: true,
    entries: reference.entries,
    status: matches ? "ready" : "mismatch",
  };
}

function shallowStudioIndexHealth(
  definition: SecondaryIndexDefinition,
  reference: SecondaryIndexReference | undefined,
  revision: number,
): StudioIndexHealth {
  if (!reference) {
    return {
      definition,
      active: false,
      entries: null,
      status: revision === 0 ? "empty" : "missing",
    };
  }
  return {
    definition,
    active: true,
    entries: reference.entries,
    status: "active",
  };
}
