import {
  BoundedReadError,
  type DatabaseEngine,
  type EngineDiagnostics,
  type DeletionPolicy,
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
  isTrieTombstone,
  trieCollectionPrefix,
  trieHeadKey,
  trieIndexKey,
  trieNodeKey,
  triePathFromHash,
  visibleTrieDocument,
  type TrieBranchNode,
  type TrieHead,
  type TrieLeafNode,
  type TrieLeafMetadata,
  type TrieNode,
  type TrieReadBundle,
  type ReadBundleLimits,
  type TrieRootNode,
  type TrieStoredDocument,
  type TrieTombstone,
} from "../trie-protocol.js";
import {
  buildSecondaryIndexPage,
  encodeSecondaryIndexPage,
  secondaryIndexDefinitionsEqual,
  secondaryIndexPageFromJson,
  updateSecondaryIndexPage,
  type CollectionIndexConfiguration,
  type SecondaryIndexChange,
  type SecondaryIndexPage,
  type SecondaryIndexReference,
  type SecondaryIndexReferences,
} from "../secondary-index.js";

type LoadedHead = {
  object: StoredObject | null;
  state: TrieHead;
};

type TrieUpdate = {
  id: string;
  document: TrieStoredDocument | null;
  first: string;
  second: string;
};

type PreparedSecondaryIndex = {
  key: string;
  bytes: Uint8Array;
  name: string;
  reference: SecondaryIndexReference;
};

export class ContentAddressedTrieEngine implements DatabaseEngine {
  readonly name = "content-addressed-trie";
  private casRetries = 0;
  private nodesCreated = 0;
  private reusedNodes = 0;
  private garbageCollected = 0;

  constructor(
    private readonly store: ObjectStore,
    private readonly maxRetries = 40,
    private readonly addressNode: (
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
    const head = await this.loadHead(normalized);
    if (head.state.rootHash === null) {
      return null;
    }

    const [first, second] = await this.pathFor(id);
    const root = await this.readNode<TrieRootNode>(
      normalized,
      head.state.rootHash,
      "root",
    );
    const branchHash = root.children[first];
    if (!branchHash) {
      return null;
    }
    const branch = await this.readNode<TrieBranchNode>(
      normalized,
      branchHash,
      "branch",
    );
    const leafHash = branch.children[second];
    if (!leafHash) {
      return null;
    }
    const leaf = await this.readNode<TrieLeafNode>(
      normalized,
      leafHash,
      "leaf",
    );
    return visibleTrieDocument(ownValue(leaf.documents, id));
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    if (head.state.rootHash === null) {
      return [];
    }

    const root = await this.readNode<TrieRootNode>(
      normalized,
      head.state.rootHash,
      "root",
    );
    const branchEntries = Object.entries(root.children).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const branchDocuments = await Promise.all(
      branchEntries.map(async ([, branchHash]) => {
        const branch = await this.readNode<TrieBranchNode>(
          normalized,
          branchHash,
          "branch",
        );
        const leafEntries = Object.entries(branch.children).sort(
          ([left], [right]) => left.localeCompare(right),
        );
        const leaves = await Promise.all(
          leafEntries.map(([, leafHash]) =>
            this.readNode<TrieLeafNode>(
              normalized,
              leafHash,
              "leaf",
            ),
          ),
        );
        return leaves.flatMap((leaf) =>
          Object.values(leaf.documents)
            .map(visibleTrieDocument)
            .filter(
              (document): document is JsonDocument =>
                document !== null,
            ),
        );
      }),
    );

    return branchDocuments
      .flat()
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
    await this.applyChanges(
      collection,
      documents.map((document) => ({
        id: document.id,
        document,
      })),
    );
  }

  rewriteIfHeadUnchanged(
    collection: string,
    documents: JsonDocument[],
    expectedHeadEtag: string | null,
  ): Promise<boolean> {
    documents.forEach(assertUserDocument);
    return this.applyChanges(
      collection,
      documents.map((document) => ({
        id: document.id,
        document,
      })),
      expectedHeadEtag,
    );
  }

  async delete(
    collection: string,
    id: string,
    policy: DeletionPolicy,
  ): Promise<boolean> {
    const normalized = validateName(collection, "Collection");
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const head = await this.loadHead(normalized);
      const current = await this.readStoredAtHead(
        normalized,
        id,
        head.state,
      );
      if (!current || isTrieTombstone(current)) {
        return false;
      }
      const now = policy.now ?? new Date();
      const restoreUntil = new Date(
        now.getTime() + policy.restoreWindowMs,
      );
      const tombstone: TrieTombstone = {
        id,
        __thimbleTombstone: {
          deletedAt: now.toISOString(),
          restoreUntil: restoreUntil.toISOString(),
          purgeAfter: new Date(
            restoreUntil.getTime() + policy.purgeGraceMs,
          ).toISOString(),
        },
        document: structuredClone(current),
      };
      if (
        await this.applyChanges(
          normalized,
          [{ id, document: tombstone }],
          head.object?.etag ?? null,
        )
      ) {
        return true;
      }
      this.casRetries += 1;
    }
    throw new Error(
      `Content-addressed trie delete exceeded ${this.maxRetries} retries`,
    );
  }

  async restore(
    collection: string,
    id: string,
    now = new Date(),
  ): Promise<JsonDocument | null> {
    const normalized = validateName(collection, "Collection");
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const head = await this.loadHead(normalized);
      const current = await this.readStoredAtHead(
        normalized,
        id,
        head.state,
      );
      if (
        !current ||
        !isTrieTombstone(current) ||
        current.__thimbleTombstone.restoreUntil < now.toISOString()
      ) {
        return null;
      }
      if (
        await this.applyChanges(
          normalized,
          [{ id, document: current.document }],
          head.object?.etag ?? null,
        )
      ) {
        return structuredClone(current.document);
      }
      this.casRetries += 1;
    }
    throw new Error(
      `Content-addressed trie restore exceeded ${this.maxRetries} retries`,
    );
  }

  async eraseAll(
    collection: string,
    policy: DeletionPolicy,
  ): Promise<number> {
    const normalized = validateName(collection, "Collection");
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const head = await this.loadHead(normalized);
      const documents = await this.scanStoredFromHead(
        normalized,
        head.state,
      );
      const visible = documents.filter(
        (document): document is JsonDocument =>
          !isTrieTombstone(document),
      );
      if (visible.length === 0) {
        return 0;
      }
      const now = policy.now ?? new Date();
      const restoreUntil = new Date(
        now.getTime() + policy.restoreWindowMs,
      );
      const changes = visible.map((document) => ({
        id: document.id,
        document: {
          id: document.id,
          __thimbleTombstone: {
            deletedAt: now.toISOString(),
            restoreUntil: restoreUntil.toISOString(),
            purgeAfter: new Date(
              restoreUntil.getTime() + policy.purgeGraceMs,
            ).toISOString(),
          },
          document: structuredClone(document),
        } satisfies TrieTombstone,
      }));
      if (
        await this.applyChanges(
          normalized,
          changes,
          head.object?.etag ?? null,
        )
      ) {
        return changes.length;
      }
      this.casRetries += 1;
    }
    throw new Error(
      `Content-addressed trie erasure exceeded ${this.maxRetries} retries`,
    );
  }

  async purgeDeleted(
    collection: string,
    now = new Date(),
  ): Promise<number> {
    const normalized = validateName(collection, "Collection");
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const head = await this.loadHead(normalized);
      const documents = await this.scanStoredFromHead(
        normalized,
        head.state,
      );
      const expired = documents.filter(
        (document): document is TrieTombstone =>
          isTrieTombstone(document) &&
          document.__thimbleTombstone.purgeAfter <= now.toISOString(),
      );
      if (expired.length === 0) {
        return 0;
      }
      if (
        await this.applyChanges(
          normalized,
          expired.map((document) => ({
            id: document.id,
            document: null,
          })),
          head.object?.etag ?? null,
        )
      ) {
        return expired.length;
      }
      this.casRetries += 1;
    }
    throw new Error(
      `Content-addressed trie purge exceeded ${this.maxRetries} retries`,
    );
  }

  async retainedDeletionCount(
    collection: string,
  ): Promise<number> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    return (
      await this.scanStoredFromHead(normalized, head.state)
    ).filter(isTrieTombstone).length;
  }

  async exportStored(
    collection: string,
  ): Promise<TrieStoredDocument[]> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    return this.scanStoredFromHead(normalized, head.state);
  }

  async exportStoredBounded(
    collection: string,
    maxRecords: number,
    maxBytes: number,
    maxTombstones?: number,
  ): Promise<TrieStoredDocument[]> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    return this.scanStoredFromHead(
      normalized,
      head.state,
      {
        maxRecords,
        maxBytes,
        ...(maxTombstones !== undefined
          ? { maxTombstones }
          : {}),
      },
    );
  }

  async replaceStored(
    collection: string,
    documents: TrieStoredDocument[],
  ): Promise<void> {
    const current = await this.exportStored(collection);
    const desiredIds = new Set(documents.map((document) => document.id));
    await this.applyChanges(collection, [
      ...documents.map((document) => ({
        id: document.id,
        document,
      })),
      ...current
        .filter((document) => !desiredIds.has(document.id))
        .map((document) => ({
          id: document.id,
          document: null,
        })),
    ]);
  }

  async rebuildIndexesFromStored(
    collection: string,
    documents: TrieStoredDocument[],
  ): Promise<void> {
    if (!this.allowIndexConfigurationChange) {
      throw new Error(
        "Rebuilding trie indexes requires explicit index configuration change mode",
      );
    }
    const normalized = validateName(collection, "Collection");
    const preparedIndexes = await this.prepareFreshIndexes(
      normalized,
      documents,
    );
    const indexes = await this.commitIndexes(preparedIndexes);
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const head = await this.loadHead(normalized);
      const nextHead: TrieHead = {
        revision: head.state.revision + 1,
        rootHash: head.state.rootHash,
        ...(Object.keys(indexes).length > 0
          ? { indexes }
          : {}),
      };
      try {
        await this.store.put(
          this.headKey(normalized),
          encodeJson(nextHead as unknown as JsonValue),
          head.object === null
            ? { ifNoneMatch: true }
            : { ifMatch: head.object.etag },
        );
        return;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.casRetries += 1;
      }
    }
    throw new Error(
      `Trie index rebuild exceeded ${this.maxRetries} retries`,
    );
  }

  async dropCollection(collection: string): Promise<number> {
    if (!this.allowQuiescentGarbageCollection) {
      throw new Error(
        "Dropping a trie collection requires quiescent garbage collection",
      );
    }
    const normalized = validateName(collection, "Collection");
    const keys = await this.store.list(
      `${this.collectionPrefix(normalized)}/`,
    );
    await Promise.all(keys.map((key) => this.store.delete(key)));
    this.garbageCollected += keys.length;
    return keys.length;
  }

  private async applyChanges(
    collection: string,
    changes: Array<{
      id: string;
      document: TrieStoredDocument | null;
    }>,
    expectedHeadEtag?: string | null,
  ): Promise<boolean> {
    const normalized = validateName(collection, "Collection");
    const collapsedChanges = [
      ...new Map(
        changes.map((change) => [change.id, change]),
      ).values(),
    ];
    const updates = await Promise.all(
      collapsedChanges.map(async (change) => {
        const [first, second] = await this.pathFor(change.id);
        return {
          id: change.id,
          document: change.document
            ? structuredClone(change.document)
            : null,
          first,
          second,
        };
      }),
    );

    const attempts =
      expectedHeadEtag === undefined ? this.maxRetries : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const head = await this.loadHead(normalized);
      await this.requireIndexConfiguration(normalized, head.state);
      if (
        expectedHeadEtag !== undefined &&
        (head.object?.etag ?? null) !== expectedHeadEtag
      ) {
        return false;
      }
      const preparedIndexes = await this.prepareIndexes(
        normalized,
        head.state,
        collapsedChanges,
      );
      const root =
        head.state.rootHash === null
          ? this.emptyRoot()
          : await this.readNode<TrieRootNode>(
              normalized,
              head.state.rootHash,
              "root",
            );
      const nextRoot: TrieRootNode = {
        kind: "root",
        children: { ...root.children },
      };

      const byBranch = groupUpdates(updates);
      const changedBranches = await Promise.all(
        [...byBranch].map(async ([first, byLeaf]) => {
          const currentBranchHash = root.children[first];
          const currentBranch = currentBranchHash
            ? await this.readNode<TrieBranchNode>(
                normalized,
                currentBranchHash,
                "branch",
              )
            : this.emptyBranch();
          const nextBranch: TrieBranchNode = {
            kind: "branch",
            children: { ...currentBranch.children },
            leafMetadata: createDictionary(
              currentBranch.leafMetadata,
            ),
          };

          const changedLeaves = await Promise.all(
            [...byLeaf].map(async ([second, leafUpdates]) => {
              const currentLeafHash =
                currentBranch.children[second];
              const currentLeaf = currentLeafHash
                ? await this.readNode<TrieLeafNode>(
                    normalized,
                    currentLeafHash,
                    "leaf",
                  )
                : this.emptyLeaf();
              const nextLeaf: TrieLeafNode = {
                kind: "leaf",
                documents: createDictionary(
                  currentLeaf.documents,
                ),
              };
              for (const update of leafUpdates) {
                if (update.document === null) {
                  delete nextLeaf.documents[update.id];
                } else {
                  nextLeaf.documents[update.id] = update.document;
                }
              }
              if (Object.keys(nextLeaf.documents).length === 0) {
                return [second, null] as const;
              }
              return [
                second,
                await this.writeLeafNode(normalized, nextLeaf),
              ] as const;
            }),
          );
          for (const [second, leafResult] of changedLeaves) {
            if (leafResult === null) {
              delete nextBranch.children[second];
              delete nextBranch.leafMetadata?.[second];
            } else {
              nextBranch.children[second] = leafResult.hash;
              nextBranch.leafMetadata ??=
                createDictionary<TrieLeafMetadata>();
              nextBranch.leafMetadata[second] =
                leafResult.metadata;
            }
          }
          if (Object.keys(nextBranch.children).length === 0) {
            return [first, null] as const;
          }

          return [
            first,
            await this.writeNode(normalized, nextBranch),
          ] as const;
        }),
      );
      for (const [first, branchHash] of changedBranches) {
        if (branchHash === null) {
          delete nextRoot.children[first];
        } else {
          nextRoot.children[first] = branchHash;
        }
      }

      const rootHash =
        Object.keys(nextRoot.children).length === 0
          ? null
          : await this.writeNode(normalized, nextRoot);
      const indexes = await this.commitIndexes(
        preparedIndexes,
      );
      const nextHead: TrieHead = {
        revision: head.state.revision + 1,
        rootHash,
        ...(Object.keys(indexes).length > 0
          ? { indexes }
          : {}),
      };

      try {
        await this.store.put(
          this.headKey(normalized),
          encodeJson(nextHead as unknown as JsonValue),
          head.object === null
            ? { ifNoneMatch: true }
            : { ifMatch: head.object.etag },
        );
        return true;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        if (expectedHeadEtag !== undefined) {
          return false;
        }
        this.casRetries += 1;
      }
    }

    if (expectedHeadEtag !== undefined) {
      return false;
    }
    throw new Error(
      `Content-addressed trie write exceeded ${this.maxRetries} retries`,
    );
  }

  async compact(collection: string): Promise<void> {
    if (!this.allowQuiescentGarbageCollection) {
      return;
    }
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    const reachable = new Set<string>();

    if (head.state.rootHash !== null) {
      reachable.add(head.state.rootHash);
      const root = await this.readNode<TrieRootNode>(
        normalized,
        head.state.rootHash,
        "root",
      );
      const branches = await Promise.all(
        Object.values(root.children).map(async (branchHash) => {
          const branch = await this.readNode<TrieBranchNode>(
            normalized,
            branchHash,
            "branch",
          );
          return { branchHash, branch };
        }),
      );
      for (const { branchHash, branch } of branches) {
        reachable.add(branchHash);
        Object.values(branch.children).forEach((leafHash) =>
          reachable.add(leafHash),
        );
      }
    }

    const nodePrefix = `${this.collectionPrefix(normalized)}/nodes/`;
    const keys = await this.store.list(nodePrefix);
    const staleKeys = keys.filter((key) => {
      const fileName = key.slice(nodePrefix.length);
      const hash = fileName.replace(/\.json$/, "");
      return !reachable.has(hash);
    });
    await Promise.all(staleKeys.map((key) => this.store.delete(key)));
    const activeIndexes = new Set(
      Object.entries(head.state.indexes ?? {}).map(
        ([name, reference]) =>
          trieIndexKey(normalized, name, reference.hash),
      ),
    );
    const indexPrefix = `${this.collectionPrefix(normalized)}/indexes/`;
    const staleIndexes = (await this.store.list(indexPrefix)).filter(
      (key) => !activeIndexes.has(key),
    );
    await Promise.all(
      staleIndexes.map((key) => this.store.delete(key)),
    );
    this.garbageCollected +=
      staleKeys.length + staleIndexes.length;
  }

  diagnostics(): EngineDiagnostics {
    return {
      casRetries: this.casRetries,
      nodesCreated: this.nodesCreated,
      reusedNodes: this.reusedNodes,
      garbageCollected: this.garbageCollected,
    };
  }

  async readBundle(
    collection: string,
    id: string,
    limits?: ReadBundleLimits,
  ): Promise<TrieReadBundle> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    const objects: TrieReadBundle["objects"] = [];
    let decodedBytes = 0;

    if (head.object !== null) {
      decodedBytes = addBundleObject(
        objects,
        decodedBytes,
        {
        key: trieHeadKey(normalized),
        etag: head.object.etag,
        value: head.state as unknown as JsonValue,
        },
        head.object.bytes.byteLength,
        limits,
      );
    }

    if (head.state.rootHash === null) {
      return {
        collection: normalized,
        id,
        revision: head.state.revision,
        document: null,
        objects,
        layout: "trie",
      };
    }

    const [first, second] = await this.pathFor(id);
    const root = await this.loadNodeObject<TrieRootNode>(
      normalized,
      head.state.rootHash,
      "root",
    );
    decodedBytes = addBundleObject(
      objects,
      decodedBytes,
      {
        key: trieNodeKey(normalized, head.state.rootHash),
        etag: root.object.etag,
        value: root.value as unknown as JsonValue,
      },
      root.object.bytes.byteLength,
      limits,
    );
    const branchHash = root.value.children[first];
    if (!branchHash) {
      return {
        collection: normalized,
        id,
        revision: head.state.revision,
        document: null,
        objects,
        layout: "trie",
      };
    }

    const branch = await this.loadNodeObject<TrieBranchNode>(
      normalized,
      branchHash,
      "branch",
    );
    decodedBytes = addBundleObject(
      objects,
      decodedBytes,
      {
        key: trieNodeKey(normalized, branchHash),
        etag: branch.object.etag,
        value: branch.value as unknown as JsonValue,
      },
      branch.object.bytes.byteLength,
      limits,
    );
    const leafHash = branch.value.children[second];
    if (!leafHash) {
      return {
        collection: normalized,
        id,
        revision: head.state.revision,
        document: null,
        objects,
        layout: "trie",
      };
    }
    if (limits) {
      const metadata = branch.value.leafMetadata?.[second];
      if (!metadata) {
        throw new BoundedReadError(
          "Trie leaf size metadata is unavailable for a bounded read bundle",
        );
      }
      assertBundleCapacity(
        objects.length + 1,
        decodedBytes + metadata.decodedBytes,
        limits,
      );
    }

    const leaf = await this.loadNodeObject<TrieLeafNode>(
      normalized,
      leafHash,
      "leaf",
    );
    addBundleObject(
      objects,
      decodedBytes,
      {
        key: trieNodeKey(
          normalized,
          leafHash,
        ),
        etag: leaf.object.etag,
        value: leaf.value as unknown as JsonValue,
      },
      leaf.object.bytes.byteLength,
      limits,
    );

    return {
      collection: normalized,
      id,
      revision: head.state.revision,
      document: visibleTrieDocument(
        ownValue(leaf.value.documents, id),
      ),
      objects,
      layout: "trie",
    };
  }

  private async loadHead(collection: string): Promise<LoadedHead> {
    const object = await this.store.get(trieHeadKey(collection));
    if (object === null) {
      return {
        object,
        state: { revision: 0, rootHash: null },
      };
    }

    return { object, state: decodeJson<TrieHead>(object.bytes) };
  }

  private async prepareIndexes(
    collection: string,
    head: TrieHead,
    changes: SecondaryIndexChange[],
  ): Promise<PreparedSecondaryIndex[]> {
    const definitions = this.indexConfiguration[collection] ?? [];
    if (definitions.length === 0) {
      return [];
    }

    let storedDocuments: TrieStoredDocument[] | undefined;
    const prepared: PreparedSecondaryIndex[] = [];
    for (const definition of definitions) {
      const currentReference = head.indexes?.[definition.name];
      let currentPage: SecondaryIndexPage | null = null;
      if (currentReference && !this.allowIndexConfigurationChange) {
        const object = await this.store.get(
          trieIndexKey(
            collection,
            definition.name,
            currentReference.hash,
          ),
        );
        if (!object) {
          throw new Error(
            `Secondary index ${definition.name} is missing`,
          );
        }
        const loadedPage = secondaryIndexPageFromJson(
          decodeJson<JsonValue>(object.bytes),
        );
        if (
          secondaryIndexDefinitionsEqual(
            loadedPage.definition,
            definition,
          )
        ) {
          currentPage = loadedPage;
        } else {
          storedDocuments ??= await this.scanStoredFromHead(
            collection,
            head,
          );
          currentPage = buildSecondaryIndexPage(
            definition,
            storedDocuments,
          );
        }
      } else {
        storedDocuments ??= await this.scanStoredFromHead(
          collection,
          head,
        );
        currentPage = buildSecondaryIndexPage(
          definition,
          storedDocuments,
        );
      }
      const page = updateSecondaryIndexPage(
        currentPage,
        definition,
        changes,
      );
      const bytes = encodeSecondaryIndexPage(page);
      const hash = await this.addressNode(bytes);
      prepared.push({
        key: trieIndexKey(
          collection,
          definition.name,
          hash,
        ),
        bytes,
        name: definition.name,
        reference: {
          hash,
          entries: page.entries.length,
          decodedBytes: bytes.byteLength,
        },
      });
    }
    return prepared;
  }

  private async prepareFreshIndexes(
    collection: string,
    documents: TrieStoredDocument[],
  ): Promise<PreparedSecondaryIndex[]> {
    const prepared: PreparedSecondaryIndex[] = [];
    for (const definition of this.indexConfiguration[collection] ?? []) {
      const page = buildSecondaryIndexPage(
        definition,
        documents,
      );
      const bytes = encodeSecondaryIndexPage(page);
      const hash = await this.addressNode(bytes);
      prepared.push({
        key: trieIndexKey(
          collection,
          definition.name,
          hash,
        ),
        bytes,
        name: definition.name,
        reference: {
          hash,
          entries: page.entries.length,
          decodedBytes: bytes.byteLength,
        },
      });
    }
    return prepared;
  }

  private async commitIndexes(
    prepared: PreparedSecondaryIndex[],
  ): Promise<SecondaryIndexReferences> {
    const references =
      createDictionary<SecondaryIndexReference>();
    for (const index of prepared) {
      try {
        await this.store.put(
          index.key,
          index.bytes,
          { ifNoneMatch: true },
        );
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
      }
      references[index.name] = index.reference;
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
    head: TrieHead,
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
        trieIndexKey(collection, name, reference.hash),
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

  private async readStoredAtHead(
    collection: string,
    id: string,
    head: TrieHead,
  ): Promise<TrieStoredDocument | null> {
    if (head.rootHash === null) {
      return null;
    }
    const [first, second] = await this.pathFor(id);
    const root = await this.readNode<TrieRootNode>(
      collection,
      head.rootHash,
      "root",
    );
    const branchHash = root.children[first];
    if (!branchHash) {
      return null;
    }
    const branch = await this.readNode<TrieBranchNode>(
      collection,
      branchHash,
      "branch",
    );
    const leafHash = branch.children[second];
    if (!leafHash) {
      return null;
    }
    const leaf = await this.readNode<TrieLeafNode>(
      collection,
      leafHash,
      "leaf",
    );
    return ownValue(leaf.documents, id) ?? null;
  }

  private async scanStoredFromHead(
    collection: string,
    head: TrieHead,
    limits?: {
      maxRecords: number;
      maxBytes: number;
      maxTombstones?: number;
    },
  ): Promise<TrieStoredDocument[]> {
    if (head.rootHash === null) {
      return [];
    }
    const root = await this.readNode<TrieRootNode>(
      collection,
      head.rootHash,
      "root",
    );
    if (!limits) {
      const branches = await Promise.all(
        Object.values(root.children).map((branchHash) =>
          this.readNode<TrieBranchNode>(
            collection,
            branchHash,
            "branch",
          ),
        ),
      );
      const leaves = await Promise.all(
        [
          ...new Set(
            branches.flatMap((branch) =>
              Object.values(branch.children),
            ),
          ),
        ].map((leafHash) =>
          this.readNode<TrieLeafNode>(
            collection,
            leafHash,
            "leaf",
          ),
        ),
      );
      return leaves
        .flatMap((leaf) => Object.values(leaf.documents))
        .sort((left, right) =>
          left.id.localeCompare(right.id),
        );
    }
    const documents: TrieStoredDocument[] = [];
    let records = 0;
    let bytes = 0;
    let tombstones = 0;
    const leafReferences: Array<{
      hash: string;
      metadata: TrieLeafMetadata;
    }> = [];
    for (const branchHash of Object.values(root.children).sort()) {
      const branch = await this.readNode<TrieBranchNode>(
        collection,
        branchHash,
        "branch",
      );
      for (const [second, hash] of Object.entries(
        branch.children,
      )) {
        const metadata = branch.leafMetadata?.[second];
        if (!metadata) {
          throw new BoundedReadError(
            "Trie leaf size metadata is unavailable; rewrite the collection before using bounded reads",
          );
        }
        records += metadata.records;
        bytes += metadata.decodedBytes;
        tombstones += metadata.tombstones;
        if (
          records > limits.maxRecords ||
          bytes > limits.maxBytes ||
          (limits.maxTombstones !== undefined &&
            tombstones > limits.maxTombstones)
        ) {
          throw new BoundedReadError(
            `Bounded stored-document read exceeded ${limits.maxRecords} records, ${limits.maxBytes} bytes, or ${limits.maxTombstones ?? "the configured"} tombstones`,
          );
        }
        leafReferences.push({ hash, metadata });
      }
    }
    for (const reference of leafReferences.sort((left, right) =>
      left.hash.localeCompare(right.hash),
    )) {
      const leaf = await this.loadNodeObject<TrieLeafNode>(
        collection,
        reference.hash,
        "leaf",
      );
      const leafDocuments = Object.values(leaf.value.documents);
      if (
        leaf.object.bytes.byteLength !==
          reference.metadata.decodedBytes ||
        leafDocuments.length !== reference.metadata.records ||
        leafDocuments.filter(isTrieTombstone).length !==
          reference.metadata.tombstones
      ) {
        throw new Error(
          `Trie leaf metadata does not match ${reference.hash}`,
        );
      }
      for (const document of leafDocuments) {
        documents.push(document);
      }
    }
    return documents.sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  private async writeNode(
    collection: string,
    node: TrieNode,
  ): Promise<string> {
    const bytes = encodeJson(node as unknown as JsonValue);
    const hash = await this.addressNode(bytes);
    try {
      await this.store.put(this.nodeKey(collection, hash), bytes, {
        ifNoneMatch: true,
      });
      this.nodesCreated += 1;
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      this.reusedNodes += 1;
    }
    return hash;
  }

  private async writeLeafNode(
    collection: string,
    leaf: TrieLeafNode,
  ): Promise<{
    hash: string;
    metadata: TrieLeafMetadata;
  }> {
    const bytes = encodeJson(leaf as unknown as JsonValue);
    const hash = await this.addressNode(bytes);
    try {
      await this.store.put(this.nodeKey(collection, hash), bytes, {
        ifNoneMatch: true,
      });
      this.nodesCreated += 1;
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      this.reusedNodes += 1;
    }
    const documents = Object.values(leaf.documents);
    return {
      hash,
      metadata: {
        records: documents.length,
        tombstones: documents.filter(isTrieTombstone).length,
        decodedBytes: bytes.byteLength,
      },
    };
  }

  private async readNode<T extends TrieNode>(
    collection: string,
    hash: string,
    expectedKind: T["kind"],
  ): Promise<T> {
    return (
      await this.loadNodeObject<T>(collection, hash, expectedKind)
    ).value;
  }

  private async loadNodeObject<T extends TrieNode>(
    collection: string,
    hash: string,
    expectedKind: T["kind"],
  ): Promise<{ object: StoredObject; value: T }> {
    const object = await this.store.get(trieNodeKey(collection, hash));
    if (object === null) {
      throw new Error(`Trie node ${hash} is missing`);
    }
    const node = decodeJson<TrieNode>(object.bytes);
    if (node.kind !== expectedKind) {
      throw new Error(
        `Trie node ${hash} is ${node.kind}, expected ${expectedKind}`,
      );
    }
    return { object, value: node as T };
  }

  private async pathFor(id: string): Promise<[string, string]> {
    return triePathFromHash(
      await hashBytes(new TextEncoder().encode(id)),
    );
  }

  private emptyRoot(): TrieRootNode {
    return { kind: "root", children: {} };
  }

  private emptyBranch(): TrieBranchNode {
    return { kind: "branch", children: {} };
  }

  private emptyLeaf(): TrieLeafNode {
    return { kind: "leaf", documents: createDictionary() };
  }

  private collectionPrefix(collection: string): string {
    return trieCollectionPrefix(collection);
  }

  private headKey(collection: string): string {
    return trieHeadKey(collection);
  }

  private nodeKey(collection: string, hash: string): string {
    return trieNodeKey(collection, hash);
  }
}

function addBundleObject(
  objects: TrieReadBundle["objects"],
  decodedBytes: number,
  object: TrieReadBundle["objects"][number],
  objectBytes: number,
  limits?: ReadBundleLimits,
): number {
  const nextBytes = decodedBytes + objectBytes;
  if (limits) {
    assertBundleCapacity(
      objects.length + 1,
      nextBytes,
      limits,
    );
  }
  objects.push(object);
  return nextBytes;
}

function assertBundleCapacity(
  objects: number,
  decodedBytes: number,
  limits: ReadBundleLimits,
): void {
  if (
    objects > limits.maxObjects ||
    decodedBytes > limits.maxDecodedBytes
  ) {
    throw new BoundedReadError(
      `Read bundle exceeds ${limits.maxObjects} objects or ${limits.maxDecodedBytes} decoded bytes`,
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

function groupUpdates(
  updates: TrieUpdate[],
): Map<string, Map<string, TrieUpdate[]>> {
  const branches = new Map<string, Map<string, TrieUpdate[]>>();
  for (const update of updates) {
    let leaves = branches.get(update.first);
    if (!leaves) {
      leaves = new Map<string, TrieUpdate[]>();
      branches.set(update.first, leaves);
    }
    const leafUpdates = leaves.get(update.second) ?? [];
    leafUpdates.push(update);
    leaves.set(update.second, leafUpdates);
  }
  return branches;
}

function assertUserDocument(document: JsonDocument): void {
  if ("__thimbleTombstone" in document) {
    throw new Error(
      'Document field "__thimbleTombstone" is reserved',
    );
  }
}
