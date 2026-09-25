import {
  BoundedReadError,
  type DatabaseEngine,
  type DeletionPolicy,
  type EngineDiagnostics,
  type JsonDocument,
  type JsonValue,
  type ObjectStore,
  type StoredObject,
} from "../core.js";
import {
  createDictionary,
  decodeJson,
  encodeJson,
  isPreconditionFailure,
  ownValue,
  validateName,
} from "../shared-utils.js";
import {
  snapshotHeadKey,
  snapshotCollectionPrefix,
  snapshotIndexKey,
  snapshotPageKey,
  type SnapshotHead,
  type SnapshotPage,
} from "../snapshot-protocol.js";
import {
  isTrieTombstone,
  visibleTrieDocument,
  type TrieReadBundle,
  type TrieStoredDocument,
  type TrieTombstone,
} from "../trie-protocol.js";
import {
  buildSecondaryIndexPage,
  secondaryIndexDefinitionsEqual,
  secondaryIndexPageFromJson,
  type CollectionIndexConfiguration,
  type SecondaryIndexReference,
  type SecondaryIndexReferences,
} from "../secondary-index.js";

type LoadedHead = {
  object: StoredObject | null;
  state: SnapshotHead;
};

export class ImmutableSnapshotEngine implements DatabaseEngine {
  readonly name = "immutable-snapshot";
  private casRetries = 0;
  private snapshotsCreated = 0;
  private reusedSnapshots = 0;
  private garbageCollected = 0;

  constructor(
    private readonly store: ObjectStore,
    private readonly maxRetries = 40,
    private readonly addressSnapshot: (
      bytes: Uint8Array,
    ) => Promise<string> | string = hashBytes,
    private readonly allowQuiescentGarbageCollection = false,
    private readonly indexConfiguration: CollectionIndexConfiguration = {},
    private readonly allowIndexConfigurationChange = false,
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    const normalized = validateName(collection, "Collection");
    const { page } = await this.loadCurrent(normalized);
    return visibleTrieDocument(ownValue(page.documents, id));
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const normalized = validateName(collection, "Collection");
    const { page } = await this.loadCurrent(normalized);
    return Object.values(page.documents)
      .map(visibleTrieDocument)
      .filter(
        (document): document is JsonDocument =>
          document !== null,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  put(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void> {
    assertUserDocument(document);
    return this.putMany(collection, [{ ...document, id }]);
  }

  async putMany(
    collection: string,
    documents: JsonDocument[],
  ): Promise<void> {
    documents.forEach(assertUserDocument);
    await this.mutate(collection, (current) => {
      for (const document of documents) {
        current[document.id] = structuredClone(document);
      }
      return { changed: true, result: undefined };
    });
  }

  async delete(
    collection: string,
    id: string,
    policy: DeletionPolicy,
  ): Promise<boolean> {
    return this.mutate(collection, (current) => {
      const document = ownValue(current, id);
      if (!document || isTrieTombstone(document)) {
        return { changed: false, result: false };
      }
      const now = policy.now ?? new Date();
      const restoreUntil = new Date(
        now.getTime() + policy.restoreWindowMs,
      );
      current[id] = {
        id,
        __thimbleTombstone: {
          deletedAt: now.toISOString(),
          restoreUntil: restoreUntil.toISOString(),
          purgeAfter: new Date(
            restoreUntil.getTime() + policy.purgeGraceMs,
          ).toISOString(),
        },
        document: structuredClone(document),
      };
      return { changed: true, result: true };
    });
  }

  async restore(
    collection: string,
    id: string,
    now = new Date(),
  ): Promise<JsonDocument | null> {
    return this.mutate(collection, (current) => {
      const document = ownValue(current, id);
      if (
        !document ||
        !isTrieTombstone(document) ||
        document.__thimbleTombstone.restoreUntil <
          now.toISOString()
      ) {
        return { changed: false, result: null };
      }
      const restored = structuredClone(document.document);
      current[id] = restored;
      return { changed: true, result: restored };
    });
  }

  async eraseAll(
    collection: string,
    policy: DeletionPolicy,
  ): Promise<number> {
    return this.mutate(collection, (current) => {
      let erased = 0;
      const now = policy.now ?? new Date();
      const restoreUntil = new Date(
        now.getTime() + policy.restoreWindowMs,
      );
      for (const [id, document] of Object.entries(current)) {
        if (isTrieTombstone(document)) {
          continue;
        }
        current[id] = {
          id,
          __thimbleTombstone: {
            deletedAt: now.toISOString(),
            restoreUntil: restoreUntil.toISOString(),
            purgeAfter: new Date(
              restoreUntil.getTime() + policy.purgeGraceMs,
            ).toISOString(),
          },
          document: structuredClone(document),
        };
        erased += 1;
      }
      return {
        changed: erased > 0,
        result: erased,
      };
    });
  }

  async purgeDeleted(
    collection: string,
    now = new Date(),
  ): Promise<number> {
    return this.mutate(collection, (current) => {
      let purged = 0;
      for (const [id, document] of Object.entries(current)) {
        if (
          isTrieTombstone(document) &&
          document.__thimbleTombstone.purgeAfter <=
            now.toISOString()
        ) {
          delete current[id];
          purged += 1;
        }
      }
      return {
        changed: purged > 0,
        result: purged,
      };
    });
  }

  async retainedDeletionCount(
    collection: string,
  ): Promise<number> {
    const normalized = validateName(collection, "Collection");
    const { page } = await this.loadCurrent(normalized);
    return Object.values(page.documents).filter(isTrieTombstone)
      .length;
  }

  async exportStored(
    collection: string,
  ): Promise<TrieStoredDocument[]> {
    const normalized = validateName(collection, "Collection");
    const { page } = await this.loadCurrent(normalized);
    return Object.values(page.documents).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async exportStoredBounded(
    collection: string,
    maxRecords: number,
    maxBytes: number,
    maxTombstones?: number,
  ): Promise<TrieStoredDocument[]> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    if (!head.state.snapshotHash) {
      return [];
    }
    if (
      typeof head.state.records !== "number" ||
      typeof head.state.tombstones !== "number" ||
      typeof head.state.decodedBytes !== "number"
    ) {
      throw new BoundedReadError(
        "Snapshot size metadata is unavailable; rewrite the collection before using bounded Studio export",
      );
    }
    if (head.state.records > maxRecords) {
      throw new BoundedReadError(
        `Bounded stored-document read exceeded ${maxRecords} records`,
      );
    }
    if (head.state.decodedBytes > maxBytes) {
      throw new BoundedReadError(
        `Bounded stored-document read exceeded ${maxBytes} bytes`,
      );
    }
    if (
      maxTombstones !== undefined &&
      head.state.tombstones > maxTombstones
    ) {
      throw new BoundedReadError(
        `Bounded stored-document read exceeded ${maxTombstones} tombstones`,
      );
    }
    const object = await this.store.get(
      snapshotPageKey(
        normalized,
        head.state.snapshotHash,
      ),
    );
    if (!object) {
      throw new Error(
        `Snapshot ${head.state.snapshotHash} is missing`,
      );
    }
    const page = decodeJson<SnapshotPage>(object.bytes);
    const documents = Object.values(page.documents);
    if (
      documents.length !== head.state.records ||
      documents.filter(isTrieTombstone).length !==
        head.state.tombstones ||
      object.bytes.byteLength !== head.state.decodedBytes
    ) {
      throw new Error("Snapshot size metadata does not match its page");
    }
    return documents.sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async replaceStored(
    collection: string,
    documents: TrieStoredDocument[],
  ): Promise<void> {
    await this.mutate(collection, (current) => {
      for (const id of Object.keys(current)) {
        delete current[id];
      }
      for (const document of documents) {
        current[document.id] = structuredClone(document);
      }
      return { changed: true, result: undefined };
    });
  }

  async dropCollection(collection: string): Promise<number> {
    if (!this.allowQuiescentGarbageCollection) {
      throw new Error(
        "Dropping a snapshot collection requires quiescent garbage collection",
      );
    }
    const normalized = validateName(collection, "Collection");
    const keys = await this.store.list(
      `${snapshotCollectionPrefix(normalized)}/`,
    );
    await Promise.all(keys.map((key) => this.store.delete(key)));
    this.garbageCollected += keys.length;
    return keys.length;
  }

  async compact(collection: string): Promise<void> {
    if (!this.allowQuiescentGarbageCollection) {
      return;
    }
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    const currentKey = head.state.snapshotHash
      ? snapshotPageKey(normalized, head.state.snapshotHash)
      : null;
    const prefix = `${snapshotCollectionPrefix(normalized)}/snapshots/`;
    const stale = (await this.store.list(prefix)).filter(
      (key) => key !== currentKey,
    );
    await Promise.all(stale.map((key) => this.store.delete(key)));
    const activeIndexes = new Set(
      Object.entries(head.state.indexes ?? {}).map(
        ([name, reference]) =>
          snapshotIndexKey(normalized, name, reference.hash),
      ),
    );
    const indexPrefix =
      `${snapshotCollectionPrefix(normalized)}/indexes/`;
    const staleIndexes = (
      await this.store.list(indexPrefix)
    ).filter((key) => !activeIndexes.has(key));
    await Promise.all(
      staleIndexes.map((key) => this.store.delete(key)),
    );
    this.garbageCollected += stale.length + staleIndexes.length;
  }

  diagnostics(): EngineDiagnostics {
    return {
      casRetries: this.casRetries,
      snapshotsCreated: this.snapshotsCreated,
      reusedSnapshots: this.reusedSnapshots,
      garbageCollected: this.garbageCollected,
    };
  }

  async readBundle(
    collection: string,
    id: string,
  ): Promise<TrieReadBundle> {
    const normalized = validateName(collection, "Collection");
    const loaded = await this.loadCurrent(normalized);
    const objects = [];
    if (loaded.head.object) {
      objects.push({
        key: snapshotHeadKey(normalized),
        etag: loaded.head.object.etag,
        value: loaded.head.state as unknown as JsonValue,
      });
    }
    if (loaded.pageObject && loaded.head.state.snapshotHash) {
      objects.push({
        key: snapshotPageKey(
          normalized,
          loaded.head.state.snapshotHash,
        ),
        etag: loaded.pageObject.etag,
        value: loaded.page as unknown as JsonValue,
      });
    }
    return {
      collection: normalized,
      id,
      revision: loaded.head.state.revision,
      document: visibleTrieDocument(
        ownValue(loaded.page.documents, id),
      ),
      objects,
    };
  }

  private async mutate<T>(
    collection: string,
    update: (
      documents: Record<string, TrieStoredDocument>,
    ) => { changed: boolean; result: T },
  ): Promise<T> {
    const normalized = validateName(collection, "Collection");
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const loaded = await this.loadCurrent(normalized);
      await this.requireIndexConfiguration(
        normalized,
        loaded.head.state,
      );
      const documents = createDictionary(
        loaded.page.documents,
      );
      const updateResult = update(documents);
      if (!updateResult.changed) {
        return updateResult.result;
      }
      const page: SnapshotPage = { documents };
      const pageBytes = encodeJson(page as unknown as JsonValue);
      const snapshotHash =
        Object.keys(documents).length === 0
          ? null
          : await this.writeSnapshot(
              normalized,
              pageBytes,
            );
      const indexes = await this.writeIndexes(
        normalized,
        Object.values(documents),
      );
      const nextHead: SnapshotHead = {
        revision: loaded.head.state.revision + 1,
        snapshotHash,
        records: Object.keys(documents).length,
        tombstones:
          Object.values(documents).filter(isTrieTombstone).length,
        decodedBytes:
          snapshotHash === null ? 0 : pageBytes.byteLength,
        ...(Object.keys(indexes).length > 0
          ? { indexes }
          : {}),
      };
      try {
        await this.store.put(
          snapshotHeadKey(normalized),
          encodeJson(nextHead as unknown as JsonValue),
          loaded.head.object
            ? { ifMatch: loaded.head.object.etag }
            : { ifNoneMatch: true },
        );
        return updateResult.result;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.casRetries += 1;
      }
    }
    throw new Error(
      `Immutable snapshot write exceeded ${this.maxRetries} retries`,
    );
  }

  private async loadCurrent(collection: string): Promise<{
    head: LoadedHead;
    page: SnapshotPage;
    pageObject: StoredObject | null;
  }> {
    const head = await this.loadHead(collection);
    if (!head.state.snapshotHash) {
      return {
        head,
        page: { documents: createDictionary() },
        pageObject: null,
      };
    }
    const pageObject = await this.store.get(
      snapshotPageKey(collection, head.state.snapshotHash),
    );
    if (!pageObject) {
      throw new Error(
        `Snapshot ${head.state.snapshotHash} is missing`,
      );
    }
    return {
      head,
      page: decodeJson<SnapshotPage>(pageObject.bytes),
      pageObject,
    };
  }

  private async loadHead(
    collection: string,
  ): Promise<LoadedHead> {
    const object = await this.store.get(snapshotHeadKey(collection));
    return object
      ? { object, state: decodeJson<SnapshotHead>(object.bytes) }
      : {
          object: null,
          state: { revision: 0, snapshotHash: null },
        };
  }

  private async writeSnapshot(
    collection: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const hash = await this.addressSnapshot(bytes);
    try {
      await this.store.put(snapshotPageKey(collection, hash), bytes, {
        ifNoneMatch: true,
      });
      this.snapshotsCreated += 1;
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      this.reusedSnapshots += 1;
    }
    return hash;
  }

  private async writeIndexes(
    collection: string,
    documents: TrieStoredDocument[],
  ): Promise<SecondaryIndexReferences> {
    const definitions = this.indexConfiguration[collection] ?? [];
    const references =
      createDictionary<SecondaryIndexReference>();
    for (const definition of definitions) {
      const page = buildSecondaryIndexPage(
        definition,
        documents,
      );
      const bytes = encodeJson(page as unknown as JsonValue);
      const hash = await this.addressSnapshot(bytes);
      try {
        await this.store.put(
          snapshotIndexKey(collection, definition.name, hash),
          bytes,
          { ifNoneMatch: true },
        );
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
      }
      references[definition.name] = {
        hash,
        entries: page.entries.length,
        decodedBytes: bytes.byteLength,
      };
    }
    return references;
  }

  async assertIndexConfiguration(collection: string): Promise<void> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    await this.requireIndexConfiguration(normalized, head.state);
  }

  private async requireIndexConfiguration(
    collection: string,
    head: SnapshotHead,
  ): Promise<void> {
    const active = Object.entries(head.indexes ?? {});
    if (this.allowIndexConfigurationChange) {
      return;
    }
    const configured = new Map(
      (this.indexConfiguration[collection] ?? []).map(
        (definition) => [definition.name, definition],
      ),
    );
    if (head.revision === 0 && active.length === 0) {
      return;
    }
    if (active.length !== configured.size) {
      throw new Error(
        `Collection ${collection} active secondary indexes do not exactly match the supplied configuration`,
      );
    }
    for (const [name, reference] of active) {
      const definition = configured.get(name);
      if (!definition) {
        throw new Error(
          `Collection ${collection} has active secondary index ${name} that is missing from the supplied configuration`,
        );
      }
      const object = await this.store.get(
        snapshotIndexKey(collection, name, reference.hash),
      );
      if (!object) {
        throw new Error(`Secondary index ${name} is missing`);
      }
      const page = secondaryIndexPageFromJson(
        decodeJson<JsonValue>(object.bytes),
      );
      if (
        !secondaryIndexDefinitionsEqual(
          page.definition,
          definition,
        )
      ) {
        throw new Error(
          `Collection ${collection} secondary index ${name} does not match the supplied configuration`,
        );
      }
    }
  }
}

function assertUserDocument(document: JsonDocument): void {
  if ("__thimbleTombstone" in document) {
    throw new Error(
      'Document field "__thimbleTombstone" is reserved',
    );
  }
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
