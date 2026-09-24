import type {
  CachePolicy,
  JsonDocument,
  JsonValue,
} from "../core.js";
import {
  trieHeadKey,
  trieIndexKey,
  trieNodeKey,
  triePathFromHash,
  visibleTrieDocument,
  type TrieBranchNode,
  type TrieHead,
  type TrieLeafNode,
  type TrieNode,
  type TrieReadBundle,
  type TrieRootNode,
} from "../trie-protocol.js";
import {
  createDictionary,
  ownValue,
  validateName,
} from "../shared-utils.js";
import {
  snapshotHeadKey,
  snapshotIndexKey,
  snapshotPageKey,
  type CollectionLayout,
  type SnapshotHead,
  type SnapshotPage,
} from "../snapshot-protocol.js";
import {
  evaluateThimbleQuery,
  pointReadId,
  validateThimbleQuery,
  type ThimbleQuery,
  type ThimbleQueryResult,
} from "../query.js";
import {
  idsFromSecondaryIndex,
  planSecondaryIndex,
  secondaryIndexDefinitionsEqual,
  secondaryIndexPageFromJson,
  type CollectionIndexConfiguration,
  type SecondaryIndexPage,
  type SecondaryIndexReference,
  type SecondaryIndexReferences,
} from "../secondary-index.js";
import {
  type BrowserCacheMetrics,
  type CachedJsonObject,
  TieredObjectCache,
} from "./cache.js";
import type {
  JsonObjectReader,
  RemoteJsonObject,
} from "./remote-reader.js";
import {
  ThimbleCollection,
  type CollectionDefinition,
  type QueryPlan,
  type ThimbleSchema,
} from "./collection.js";

export type ThimbleClientMetrics = {
  remoteReads: number;
  remoteBytes: number;
  notModified: number;
  missing: number;
  offlineFallbacks: number;
  cache: BrowserCacheMetrics;
};

export class ThimbleClient {
  private remoteReads = 0;
  private remoteBytes = 0;
  private notModified = 0;
  private missing = 0;
  private offlineFallbacks = 0;
  private active = true;
  private lifecycleGeneration = 0;
  private layoutCheckedAt = 0;
  private layoutCheckPromise: Promise<void> | undefined;
  private readonly immutableReads = new Map<
    string,
    Promise<RemoteJsonObject>
  >();
  private readonly channel: BroadcastChannel | null;

  constructor(
    private readonly options: {
      reader: JsonObjectReader;
      cache: TieredObjectCache;
      headTtlMs: number;
      writeBaseUrl?: string;
      csrfToken?: string;
      scopeId?: string;
      scopeKeyId?: string | null;
      keyExpiresAt?: string;
      channelName?: string;
      fetchImplementation?: typeof fetch;
      onLogout?: (error?: unknown) => void;
      collectionLayouts?: Record<string, CollectionLayout>;
      collectionIndexes?: CollectionIndexConfiguration;
      layoutGeneration?: string;
      configurationUrl?: string;
      layoutCheckTtlMs?: number;
      onLayoutChange?: () => void;
    },
  ) {
    this.channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(
            options.channelName ?? "thimbledb-updates",
          );
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (isReadBundle(event.data)) {
          void this.applyBundle(
            event.data,
            false,
            this.lifecycleGeneration,
          ).catch(() => undefined);
        } else if (isLogoutMessage(event.data)) {
          void this.handleLogout().catch(() => undefined);
        } else if (isLayoutChangeMessage(event.data)) {
          void this.handleLayoutChange().catch(() => undefined);
        }
      };
    }
    if (options.keyExpiresAt) {
      const delay =
        new Date(options.keyExpiresAt).getTime() - Date.now();
      if (delay <= 0) {
        void this.handleLogout().catch(() => undefined);
      } else {
        setTimeout(
          () => void this.handleLogout().catch(() => undefined),
          Math.min(delay, 2_147_483_647),
        );
      }
    }
  }

  setCachePolicy(policy: CachePolicy): void {
    this.options.cache.setPolicy(policy);
  }

  collection<T extends { id: string }>(
    definition: CollectionDefinition<T>,
  ): ThimbleCollection<T>;
  collection<T extends { id: string } = JsonDocument>(
    name: string,
    schema?: ThimbleSchema<T>,
  ): ThimbleCollection<T>;
  collection<T extends { id: string }>(
    definitionOrName: CollectionDefinition<T> | string,
    schema?: ThimbleSchema<T>,
  ): ThimbleCollection<T> {
    return new ThimbleCollection(
      this,
      typeof definitionOrName === "string"
        ? defineInlineCollection(definitionOrName, schema)
        : definitionOrName,
    );
  }

  async queryDocuments<T extends { id: string }>(
    collection: string,
    query: ThimbleQuery<T>,
  ): Promise<ThimbleQueryResult<T>> {
    validateThimbleQuery(query);
    const pointId = pointReadId(query);
    if (pointId) {
      const document = await this.get(collection, pointId);
      return {
        documents: document ? [document as unknown as T] : [],
        plan: "point",
        indexName: null,
        scannedDocuments: document ? 1 : 0,
      };
    }
    const definitions =
      this.options.collectionIndexes?.[collection] ?? [];
    const indexPlan = planSecondaryIndex(definitions, query);
    if (indexPlan) {
      await this.ensureLayoutCurrent(false);
      const generation = this.currentGeneration();
      const layout = this.layoutFor(collection);
      const head =
        layout === "snapshot"
          ? await this.readSnapshotHead(collection, generation)
          : await this.readHead(collection, generation);
      const reference = head.indexes?.[indexPlan.definition.name];
      if (reference) {
        const page = await this.readSecondaryIndexPage(
          layout,
          collection,
          indexPlan.definition.name,
          reference.hash,
          generation,
        );
        if (
          !secondaryIndexDefinitionsEqual(
            page.definition,
            indexPlan.definition,
          )
        ) {
          return evaluateThimbleQuery(
            (await this.scan(collection)) as unknown as T[],
            query,
          );
        }
        if (reference.entries !== page.entries.length) {
          throw new Error(
            `Secondary index ${indexPlan.definition.name} entry count does not match its collection head`,
          );
        }
        const ids = idsFromSecondaryIndex(page, indexPlan);
        const maximum = query.maxScanDocuments ?? 1_000;
        if (ids.length > maximum) {
          throw new Error(
            `Secondary index ${indexPlan.definition.name} matched ${ids.length} documents, above the configured maximum of ${maximum}`,
          );
        }
        const documents = (
          await Promise.all(
            ids.map((id) => this.get(collection, id)),
          )
        ).filter(
          (document): document is JsonDocument =>
            document !== null,
        ) as unknown as T[];
        const result = evaluateThimbleQuery(documents, {
          ...query,
          maxScanDocuments: maximum,
        });
        return {
          ...result,
          plan: "index",
          indexName: indexPlan.definition.name,
          scannedDocuments: ids.length,
        };
      }
    }
    return evaluateThimbleQuery(
      (await this.scan(collection)) as unknown as T[],
      query,
    );
  }

  explainQuery<T extends { id: string }>(
    collection: string,
    query: ThimbleQuery<T>,
  ): QueryPlan {
    validateThimbleQuery(query);
    if (pointReadId(query)) {
      return {
        plan: "point",
        indexName: null,
        reason: "ID equality resolves to a direct document read",
      };
    }
    const indexPlan = planSecondaryIndex(
      this.options.collectionIndexes?.[collection] ?? [],
      query,
    );
    if (indexPlan) {
      return {
        plan: "index",
        indexName: indexPlan.definition.name,
        reason:
          `Query fields match configured ${indexPlan.definition.mode} index ${indexPlan.definition.name}`,
      };
    }
    return {
      plan: "scan",
      indexName: null,
      reason:
        "No configured secondary index matches the bounded query",
    };
  }

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    await this.ensureLayoutCurrent(false);
    const generation = this.currentGeneration();
    if (this.layoutFor(collection) === "snapshot") {
      return this.getSnapshot(collection, id, generation);
    }

    const head = await this.readHead(collection, generation);
    if (head.rootHash === null) {
      return null;
    }

    const [first, second] = triePathFromHash(await hashId(id));
    this.assertGeneration(generation);
    const root = await this.readNode<TrieRootNode>(
      collection,
      head.rootHash,
      "root",
      generation,
    );
    const branchHash = root.children[first];
    if (!branchHash) {
      return null;
    }
    const branch = await this.readNode<TrieBranchNode>(
      collection,
      branchHash,
      "branch",
      generation,
    );
    const leafHash = branch.children[second];
    if (!leafHash) {
      return null;
    }
    const leaf = await this.readNode<TrieLeafNode>(
      collection,
      leafHash,
      "leaf",
      generation,
    );
    this.assertGeneration(generation);
    return visibleTrieDocument(ownValue(leaf.documents, id));
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    await this.ensureLayoutCurrent(false);
    const generation = this.currentGeneration();
    if (this.layoutFor(collection) === "snapshot") {
      return this.scanSnapshot(collection, generation);
    }
    const head = await this.readHead(collection, generation);
    if (head.rootHash === null) {
      return [];
    }
    const root = await this.readNode<TrieRootNode>(
      collection,
      head.rootHash,
      "root",
      generation,
    );
    const branches = await Promise.all(
      Object.values(root.children).map((hash) =>
        this.readNode<TrieBranchNode>(
          collection,
          hash,
          "branch",
          generation,
        ),
      ),
    );
    const leafHashes = [
      ...new Set(
        branches.flatMap((branch) =>
          Object.values(branch.children),
        ),
      ),
    ];
    const leaves = await Promise.all(
      leafHashes.map((hash) =>
        this.readNode<TrieLeafNode>(
          collection,
          hash,
          "leaf",
          generation,
        ),
      ),
    );
    this.assertGeneration(generation);
    return leaves
      .flatMap((leaf) =>
        Object.values(leaf.documents)
          .map(visibleTrieDocument)
          .filter(
            (document): document is JsonDocument =>
              document !== null,
          ),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async write(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<TrieReadBundle> {
    await this.ensureLayoutCurrent(true);
    this.requireActive();
    const generation = this.lifecycleGeneration;
    const baseUrl = this.options.writeBaseUrl ?? "";
    const fetchImplementation =
      this.options.fetchImplementation ?? fetch;
    const response = await fetchImplementation.call(
      globalThis,
      `${baseUrl}/api/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(this.options.csrfToken
            ? { "x-thimble-csrf": this.options.csrfToken }
            : {}),
          ...(this.options.scopeId
            ? { "x-thimble-scope": this.options.scopeId }
            : {}),
          ...(this.options.layoutGeneration
            ? {
                "x-thimble-layout-generation":
                  this.options.layoutGeneration,
              }
            : {}),
        },
        body: JSON.stringify({ ...document, id }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Write failed with ${response.status}: ${await response.text()}`,
      );
    }
    const bundle = (await response.json()) as TrieReadBundle;
    if (!this.active || generation !== this.lifecycleGeneration) {
      throw new Error("ThimbleDB client is logged out");
    }
    await this.applyBundle(bundle, true, generation);
    return bundle;
  }

  async delete(
    collection: string,
    id: string,
  ): Promise<TrieReadBundle> {
    return this.mutateDocument(
      "DELETE",
      collection,
      id,
      "{}",
    );
  }

  async restore(
    collection: string,
    id: string,
  ): Promise<TrieReadBundle> {
    return this.mutateDocument(
      "POST",
      collection,
      `${id}/restore`,
      "{}",
    );
  }

  async applyBundle(
    bundle: TrieReadBundle,
    broadcast = false,
    generation = this.lifecycleGeneration,
  ): Promise<void> {
    this.requireActive();
    if (generation !== this.lifecycleGeneration) {
      return;
    }
    const head = bundle.objects.find((object) =>
      object.key.endsWith("/HEAD.json"),
    );
    const bundleLayout = bundle.objects.some((object) =>
      object.key.startsWith("content-snapshot/"),
    )
      ? "snapshot"
      : "trie";
    if (bundleLayout !== this.layoutFor(bundle.collection)) {
      await this.handleLayoutChange();
      throw new Error("Collection layout changed; reload required");
    }
    await withBrowserLock(this.lifecycleLockName(), async () => {
      if (!this.active || generation !== this.lifecycleGeneration) {
        return;
      }
      if (head) {
        const cached = await this.options.cache.get(head.key);
        const cachedRevision = cached
          ? revisionFromValue(cached.value)
          : -1;
        const incomingRevision = revisionFromValue(head.value);
        if (cachedRevision >= incomingRevision) {
          return;
        }
      }
      const now = Date.now();
      await Promise.all(
        bundle.objects.map((object) =>
          this.options.cache.set({
            key: object.key,
            etag: object.etag,
            value: object.value,
            cachedAt: now,
            checkedAt: now,
            immutable: !object.key.endsWith("/HEAD.json"),
          }),
        ),
      );
    });
    if (!this.active || generation !== this.lifecycleGeneration) {
      return;
    }
    if (broadcast) {
      this.channel?.postMessage(bundle);
    }
  }

  clearMemory(): void {
    this.options.cache.clearMemory();
  }

  clearAll(): Promise<void> {
    return this.options.cache.clearAll();
  }

  async logout(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.channel?.postMessage({ type: "logout" });
    await this.handleLogout();
  }

  resetMetrics(): void {
    this.remoteReads = 0;
    this.remoteBytes = 0;
    this.notModified = 0;
    this.missing = 0;
    this.offlineFallbacks = 0;
    this.options.cache.resetMetrics();
  }

  metrics(): ThimbleClientMetrics {
    return {
      remoteReads: this.remoteReads,
      remoteBytes: this.remoteBytes,
      notModified: this.notModified,
      missing: this.missing,
      offlineFallbacks: this.offlineFallbacks,
      cache: this.options.cache.metrics(),
    };
  }

  close(): void {
    this.active = false;
    this.channel?.close();
  }

  private async readHead(
    collection: string,
    generation: number,
  ): Promise<TrieHead> {
    this.assertGeneration(generation);
    const key = trieHeadKey(collection);
    return withBrowserLock(`thimbledb:${key}`, async () => {
      const cached = await this.options.cache.get(key);
      this.assertGeneration(generation);
      const now = Date.now();
      if (
        cached &&
        now - cached.checkedAt < this.options.headTtlMs
      ) {
        return asHead(cached.value);
      }

      let remote: RemoteJsonObject;
      try {
        remote = await this.readRemote(key, cached?.etag);
      } catch (error) {
        if (cached && this.active) {
          this.offlineFallbacks += 1;
          this.assertGeneration(generation);
          return asHead(cached.value);
        }
        throw error;
      }
      if (remote.status === "not-modified" && cached) {
        const refreshed = { ...cached, checkedAt: now };
        await this.cacheSetIfActive(refreshed, generation);
        this.assertGeneration(generation);
        return asHead(refreshed.value);
      }
      if (remote.status === "missing") {
        this.assertGeneration(generation);
        return { revision: 0, rootHash: null };
      }
      if (remote.status !== "found") {
        throw new Error(`Cannot resolve HEAD for ${collection}`);
      }

      await this.cacheSetIfActive(
        cacheEntryFromRemote(remote, false),
        generation,
      );
      this.assertGeneration(generation);
      return asHead(remote.value);
    });
  }

  private async getSnapshot(
    collection: string,
    id: string,
    generation: number,
  ): Promise<JsonDocument | null> {
    const head = await this.readSnapshotHead(collection, generation);
    if (!head.snapshotHash) {
      return null;
    }
    const page = await this.readSnapshotPage(
      collection,
      head.snapshotHash,
      generation,
    );
    return visibleTrieDocument(ownValue(page.documents, id));
  }

  private async scanSnapshot(
    collection: string,
    generation: number,
  ): Promise<JsonDocument[]> {
    const head = await this.readSnapshotHead(collection, generation);
    if (!head.snapshotHash) {
      return [];
    }
    const page = await this.readSnapshotPage(
      collection,
      head.snapshotHash,
      generation,
    );
    return Object.values(page.documents)
      .map(visibleTrieDocument)
      .filter(
        (document): document is JsonDocument =>
          document !== null,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readSnapshotHead(
    collection: string,
    generation: number,
  ): Promise<SnapshotHead> {
    this.assertGeneration(generation);
    const key = snapshotHeadKey(collection);
    return withBrowserLock(`thimbledb:${key}`, async () => {
      const cached = await this.options.cache.get(key);
      this.assertGeneration(generation);
      const now = Date.now();
      if (
        cached &&
        now - cached.checkedAt < this.options.headTtlMs
      ) {
        return asSnapshotHead(cached.value);
      }
      let remote: RemoteJsonObject;
      try {
        remote = await this.readRemote(key, cached?.etag);
      } catch (error) {
        if (cached && this.active) {
          this.offlineFallbacks += 1;
          this.assertGeneration(generation);
          return asSnapshotHead(cached.value);
        }
        throw error;
      }
      if (remote.status === "not-modified" && cached) {
        const refreshed = { ...cached, checkedAt: now };
        await this.cacheSetIfActive(refreshed, generation);
        return asSnapshotHead(refreshed.value);
      }
      if (remote.status === "missing") {
        return { revision: 0, snapshotHash: null };
      }
      if (remote.status !== "found") {
        throw new Error(
          `Cannot resolve snapshot HEAD for ${collection}`,
        );
      }
      await this.cacheSetIfActive(
        cacheEntryFromRemote(remote, false),
        generation,
      );
      return asSnapshotHead(remote.value);
    });
  }

  private async readSnapshotPage(
    collection: string,
    hash: string,
    generation: number,
  ): Promise<SnapshotPage> {
    const key = snapshotPageKey(collection, hash);
    const cached = await this.options.cache.get(key);
    this.assertGeneration(generation);
    if (cached) {
      return asSnapshotPage(cached.value);
    }
    const remote = await this.readImmutableRemote(key);
    this.assertGeneration(generation);
    if (remote.status !== "found") {
      throw new Error(`Immutable snapshot ${key} is unavailable`);
    }
    await this.cacheSetIfActive(
      cacheEntryFromRemote(remote, true),
      generation,
    );
    return asSnapshotPage(remote.value);
  }

  private async readSecondaryIndexPage(
    layout: CollectionLayout,
    collection: string,
    indexName: string,
    hash: string,
    generation: number,
  ): Promise<SecondaryIndexPage> {
    const key =
      layout === "snapshot"
        ? snapshotIndexKey(collection, indexName, hash)
        : trieIndexKey(collection, indexName, hash);
    const cached = await this.options.cache.get(key);
    this.assertGeneration(generation);
    if (cached) {
      return secondaryIndexPageFromJson(cached.value);
    }
    const remote = await this.readImmutableRemote(key);
    this.assertGeneration(generation);
    if (remote.status !== "found") {
      throw new Error(`Secondary index ${key} is unavailable`);
    }
    await this.cacheSetIfActive(
      cacheEntryFromRemote(remote, true),
      generation,
    );
    return secondaryIndexPageFromJson(remote.value);
  }

  private async readNode<T extends TrieNode>(
    collection: string,
    hash: string,
    expectedKind: T["kind"],
    generation: number,
  ): Promise<T> {
    this.assertGeneration(generation);
    const key = trieNodeKey(collection, hash);
    const cached = await this.options.cache.get(key);
    this.assertGeneration(generation);
    if (cached) {
      return asNode<T>(cached.value, expectedKind);
    }

    const remote = await this.readImmutableRemote(key);
    this.assertGeneration(generation);
    if (remote.status !== "found") {
      throw new Error(`Immutable node ${key} is unavailable`);
    }
    await this.cacheSetIfActive(
      cacheEntryFromRemote(remote, true),
      generation,
    );
    this.assertGeneration(generation);
    return asNode<T>(remote.value, expectedKind);
  }

  private async handleLogout(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.lifecycleGeneration += 1;
    let failure: unknown;
    try {
      await withBrowserLock(
        this.lifecycleLockName(),
        () => this.options.cache.destroy(),
      );
    } catch (error) {
      failure = error;
    }
    this.channel?.close();
    this.options.onLogout?.(failure);
    if (failure) {
      throw failure;
    }
  }

  private requireActive(): void {
    if (
      this.options.keyExpiresAt &&
      new Date(this.options.keyExpiresAt).getTime() <= Date.now()
    ) {
      void this.handleLogout().catch(() => undefined);
    }
    if (!this.active) {
      throw new Error("ThimbleDB client is logged out");
    }
  }

  private currentGeneration(): number {
    this.requireActive();
    return this.lifecycleGeneration;
  }

  private assertGeneration(generation: number): void {
    this.requireActive();
    if (generation !== this.lifecycleGeneration) {
      throw new Error("ThimbleDB client is logged out");
    }
  }

  private lifecycleLockName(): string {
    return `thimbledb:lifecycle:${this.options.scopeId ?? "default"}`;
  }

  private layoutFor(collection: string): CollectionLayout {
    return this.options.collectionLayouts?.[collection] ?? "trie";
  }

  private cacheSetIfActive(
    entry: CachedJsonObject,
    generation: number,
  ): Promise<void> {
    return withBrowserLock(this.lifecycleLockName(), async () => {
      this.assertGeneration(generation);
      await this.options.cache.set(entry);
      this.assertGeneration(generation);
    });
  }

  private async readRemote(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject> {
    this.remoteReads += 1;
    const result = await this.options.reader.get(key, ifNoneMatch);
    if (result.status === "found") {
      this.remoteBytes += result.bytes;
    } else if (result.status === "not-modified") {
      this.notModified += 1;
    } else {
      this.missing += 1;
    }
    return result;
  }

  private readImmutableRemote(
    key: string,
  ): Promise<RemoteJsonObject> {
    const current = this.immutableReads.get(key);
    if (current) {
      return current;
    }
    const pending = this.readRemote(key).finally(() => {
      if (this.immutableReads.get(key) === pending) {
        this.immutableReads.delete(key);
      }
    });
    this.immutableReads.set(key, pending);
    return pending;
  }

  private async mutateDocument(
    method: "DELETE" | "POST",
    collection: string,
    routeId: string,
    body: string,
  ): Promise<TrieReadBundle> {
    await this.ensureLayoutCurrent(true);
    const generation = this.currentGeneration();
    const baseUrl = this.options.writeBaseUrl ?? "";
    const fetchImplementation =
      this.options.fetchImplementation ?? fetch;
    const response = await fetchImplementation.call(
      globalThis,
      `${baseUrl}/api/collections/${encodeURIComponent(collection)}/documents/${routeId
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`,
      {
        method,
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(this.options.csrfToken
            ? { "x-thimble-csrf": this.options.csrfToken }
            : {}),
          ...(this.options.scopeId
            ? { "x-thimble-scope": this.options.scopeId }
            : {}),
          ...(this.options.layoutGeneration
            ? {
                "x-thimble-layout-generation":
                  this.options.layoutGeneration,
              }
            : {}),
        },
        body,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Mutation failed with ${response.status}: ${await response.text()}`,
      );
    }
    const bundle = (await response.json()) as TrieReadBundle;
    this.assertGeneration(generation);
    await this.applyBundle(bundle, true, generation);
    return bundle;
  }

  private ensureLayoutCurrent(force: boolean): Promise<void> {
    if (
      !this.options.layoutGeneration ||
      !this.options.configurationUrl
    ) {
      return Promise.resolve();
    }
    const ttl = this.options.layoutCheckTtlMs ?? 1_000;
    if (!force && Date.now() - this.layoutCheckedAt < ttl) {
      return Promise.resolve();
    }
    this.layoutCheckPromise ??= this.checkLayoutGeneration().finally(
      () => {
        this.layoutCheckPromise = undefined;
      },
    );
    return this.layoutCheckPromise;
  }

  private async checkLayoutGeneration(): Promise<void> {
    this.requireActive();
    const fetchImplementation =
      this.options.fetchImplementation ?? fetch;
    const response = await fetchImplementation.call(
      globalThis,
      this.options.configurationUrl!,
      {
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(
        `Layout configuration check failed with ${response.status}`,
      );
    }
    const config = (await response.json()) as {
      layoutGeneration?: unknown;
      scope?: {
        keyId?: unknown;
      };
    };
    if (
      config.layoutGeneration !== this.options.layoutGeneration ||
      config.scope?.keyId !== this.options.scopeKeyId
    ) {
      await this.handleLayoutChange();
      throw new Error(
        "Authority configuration changed; reload required",
      );
    }
    this.layoutCheckedAt = Date.now();
  }

  private async handleLayoutChange(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.lifecycleGeneration += 1;
    this.channel?.postMessage({ type: "layout-change" });
    try {
      await withBrowserLock(
        this.lifecycleLockName(),
        () => this.options.cache.destroy(),
      );
    } finally {
      this.channel?.close();
      this.options.onLayoutChange?.();
    }
  }
}

function revisionFromValue(value: JsonValue): number {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.revision === "number"
    ? value.revision
    : -1;
}

function asSnapshotHead(value: JsonValue): SnapshotHead {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.revision !== "number" ||
    !(
      value.snapshotHash === null ||
      typeof value.snapshotHash === "string"
    )
  ) {
    throw new Error("Invalid snapshot HEAD object");
  }
  return {
    revision: value.revision,
    snapshotHash: value.snapshotHash,
    ...indexesFromValue(value.indexes),
  };
}

function asSnapshotPage(value: JsonValue): SnapshotPage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.documents !== "object" ||
    value.documents === null ||
    Array.isArray(value.documents)
  ) {
    throw new Error("Invalid snapshot page object");
  }
  return value as unknown as SnapshotPage;
}

function cacheEntryFromRemote(
  remote: Extract<RemoteJsonObject, { status: "found" }>,
  immutable: boolean,
): CachedJsonObject {
  const now = Date.now();
  return {
    key: remote.key,
    etag: remote.etag,
    value: remote.value,
    cachedAt: now,
    checkedAt: now,
    immutable,
  };
}

async function hashId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(id),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function asHead(value: JsonValue): TrieHead {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.revision !== "number" ||
    !(
      value.rootHash === null ||
      typeof value.rootHash === "string"
    )
  ) {
    throw new Error("Invalid trie HEAD object");
  }
  return {
    revision: value.revision,
    rootHash: value.rootHash,
    ...indexesFromValue(value.indexes),
  };
}

function indexesFromValue(
  value: JsonValue | undefined,
): { indexes?: SecondaryIndexReferences } {
  if (value === undefined) {
    return {};
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Invalid secondary index references");
  }
  const indexes =
    createDictionary<SecondaryIndexReference>();
  for (const [name, reference] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      typeof reference !== "object" ||
      reference === null ||
      Array.isArray(reference) ||
      typeof reference.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(reference.hash) ||
      typeof reference.entries !== "number" ||
      !Number.isInteger(reference.entries) ||
      reference.entries < 0
    ) {
      throw new Error(
        `Invalid secondary index reference: ${name}`,
      );
    }
    indexes[name] = {
      hash: reference.hash,
      entries: reference.entries,
    };
  }
  return { indexes };
}

function asNode<T extends TrieNode>(
  value: JsonValue,
  expectedKind: T["kind"],
): T {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.kind !== expectedKind
  ) {
    throw new Error(`Invalid ${expectedKind} trie node`);
  }
  return value as T;
}

function defineInlineCollection<T extends { id: string }>(
  name: string,
  schema?: ThimbleSchema<T>,
): CollectionDefinition<T> {
  return {
    name: validateName(name, "Collection"),
    ...(schema ? { schema } : {}),
  };
}

function isReadBundle(value: unknown): value is TrieReadBundle {
  return (
    typeof value === "object" &&
    value !== null &&
    "collection" in value &&
    "objects" in value &&
    Array.isArray(value.objects)
  );
}

function isLogoutMessage(
  value: unknown,
): value is { type: "logout" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "logout"
  );
}

function isLayoutChangeMessage(
  value: unknown,
): value is { type: "layout-change" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "layout-change"
  );
}

async function withBrowserLock<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    typeof navigator !== "undefined" &&
    navigator.locks
  ) {
    return navigator.locks.request(name, operation);
  }
  return operation();
}
