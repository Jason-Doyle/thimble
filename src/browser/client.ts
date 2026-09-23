import type {
  CachePolicy,
  JsonDocument,
  JsonValue,
} from "../core.js";
import {
  trieHeadKey,
  trieNodeKey,
  triePathFromHash,
  type TrieBranchNode,
  type TrieHead,
  type TrieLeafNode,
  type TrieNode,
  type TrieReadBundle,
  type TrieRootNode,
} from "../trie-protocol.js";
import { ownValue } from "../shared-utils.js";
import {
  type BrowserCacheMetrics,
  type CachedJsonObject,
  TieredObjectCache,
} from "./cache.js";
import type {
  JsonObjectReader,
  RemoteJsonObject,
} from "./remote-reader.js";

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
  private readonly channel: BroadcastChannel | null;

  constructor(
    private readonly options: {
      reader: JsonObjectReader;
      cache: TieredObjectCache;
      headTtlMs: number;
      writeBaseUrl?: string;
      csrfToken?: string;
      scopeId?: string;
      keyExpiresAt?: string;
      channelName?: string;
      fetchImplementation?: typeof fetch;
      onLogout?: () => void;
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
          void this.applyBundle(event.data, false);
        } else if (isLogoutMessage(event.data)) {
          void this.handleLogout();
        }
      };
    }
    if (options.keyExpiresAt) {
      const delay =
        new Date(options.keyExpiresAt).getTime() - Date.now();
      if (delay <= 0) {
        void this.handleLogout();
      } else {
        setTimeout(
          () => void this.handleLogout(),
          Math.min(delay, 2_147_483_647),
        );
      }
    }
  }

  setCachePolicy(policy: CachePolicy): void {
    this.options.cache.setPolicy(policy);
  }

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    this.requireActive();
    const head = await this.readHead(collection);
    if (head.rootHash === null) {
      return null;
    }

    const [first, second] = triePathFromHash(await hashId(id));
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

  async scan(collection: string): Promise<JsonDocument[]> {
    this.requireActive();
    const head = await this.readHead(collection);
    if (head.rootHash === null) {
      return [];
    }
    const root = await this.readNode<TrieRootNode>(
      collection,
      head.rootHash,
      "root",
    );
    const branches = await Promise.all(
      Object.values(root.children).map((hash) =>
        this.readNode<TrieBranchNode>(
          collection,
          hash,
          "branch",
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
        this.readNode<TrieLeafNode>(collection, hash, "leaf"),
      ),
    );
    return leaves
      .flatMap((leaf) => Object.values(leaf.documents))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async write(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<TrieReadBundle> {
    this.requireActive();
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
    await this.applyBundle(bundle, true);
    return bundle;
  }

  async applyBundle(
    bundle: TrieReadBundle,
    broadcast = false,
  ): Promise<void> {
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

  private async readHead(collection: string): Promise<TrieHead> {
    this.requireActive();
    const key = trieHeadKey(collection);
    return withBrowserLock(`thimbledb:${key}`, async () => {
      const cached = await this.options.cache.get(key);
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
          return asHead(cached.value);
        }
        throw error;
      }
      if (remote.status === "not-modified" && cached) {
        const refreshed = { ...cached, checkedAt: now };
        await this.options.cache.set(refreshed);
        return asHead(refreshed.value);
      }
      if (remote.status === "missing") {
        return { revision: 0, rootHash: null };
      }
      if (remote.status !== "found") {
        throw new Error(`Cannot resolve HEAD for ${collection}`);
      }

      await this.options.cache.set(
        cacheEntryFromRemote(remote, false),
      );
      return asHead(remote.value);
    });
  }

  private async readNode<T extends TrieNode>(
    collection: string,
    hash: string,
    expectedKind: T["kind"],
  ): Promise<T> {
    this.requireActive();
    const key = trieNodeKey(collection, hash);
    const cached = await this.options.cache.get(key);
    if (cached) {
      return asNode<T>(cached.value, expectedKind);
    }

    const remote = await this.readRemote(key);
    if (remote.status !== "found") {
      throw new Error(`Immutable node ${key} is unavailable`);
    }
    await this.options.cache.set(
      cacheEntryFromRemote(remote, true),
    );
    return asNode<T>(remote.value, expectedKind);
  }

  private async handleLogout(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.active = false;
    await withBrowserLock(
      `thimbledb:logout:${this.options.scopeId ?? "default"}`,
      () => this.options.cache.destroy(),
    );
    this.channel?.close();
    this.options.onLogout?.();
  }

  private requireActive(): void {
    if (
      this.options.keyExpiresAt &&
      new Date(this.options.keyExpiresAt).getTime() <= Date.now()
    ) {
      void this.handleLogout();
    }
    if (!this.active) {
      throw new Error("ThimbleDB client is logged out");
    }
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
  };
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
