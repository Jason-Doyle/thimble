import type {
  CachePolicy,
  JsonValue,
} from "../core.js";

export type CachedJsonObject = {
  key: string;
  etag: string;
  value: JsonValue;
  cachedAt: number;
  checkedAt: number;
  immutable: boolean;
};

type PersistedCacheEntry = Omit<CachedJsonObject, "value"> & {
  cacheKey: string;
  namespace: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type PersistedDeviceKey = {
  keyId: string;
  key: CryptoKey;
};

export type BrowserCacheMetrics = {
  policy: CachePolicy;
  memoryHits: number;
  indexedDbHits: number;
  misses: number;
  writes: number;
  memoryEntries: number;
  memoryBytes: number;
  evictions: number;
};

export class MemoryObjectCache {
  private readonly entries = new Map<
    string,
    { entry: CachedJsonObject; bytes: number }
  >();
  private totalBytes = 0;
  private evictionCount = 0;

  constructor(
    private readonly maxEntries = 512,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  get(key: string): CachedJsonObject | null {
    const cached = this.entries.get(key);
    if (!cached) {
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, cached);
    return structuredClone(cached.entry);
  }

  set(entry: CachedJsonObject): void {
    this.delete(entry.key);
    const bytes = estimateEntryBytes(entry);
    this.entries.set(entry.key, {
      entry: structuredClone(entry),
      bytes,
    });
    this.totalBytes += bytes;
    this.evictIfNeeded();
  }

  delete(key: string): void {
    const cached = this.entries.get(key);
    if (!cached) {
      return;
    }
    this.totalBytes -= cached.bytes;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): {
    entries: number;
    bytes: number;
    evictions: number;
  } {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      evictions: this.evictionCount,
    };
  }

  private evictIfNeeded(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value as
        | string
        | undefined;
      if (!oldest) {
        return;
      }
      this.delete(oldest);
      this.evictionCount += 1;
    }
  }
}

export class IndexedDbObjectCache {
  private databasePromise: Promise<IDBDatabase> | undefined;
  private deviceKeyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly namespace: string,
    private readonly databaseName = "thimbledb-cache-v1",
  ) {}

  async get(key: string): Promise<CachedJsonObject | null> {
    const database = await this.database();
    const value = await requestToPromise<PersistedCacheEntry | undefined>(
      database
        .transaction("objects", "readonly")
        .objectStore("objects")
        .get(this.cacheKey(key)),
    );
    if (!value) {
      return null;
    }
    const deviceKey = await this.deviceKey(database);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: value.iv,
          tagLength: 128,
        },
        deviceKey,
        value.ciphertext,
      );
    } catch {
      await this.delete(key);
      return null;
    }
    const {
      cacheKey: _cacheKey,
      namespace: _namespace,
      iv: _iv,
      ciphertext: _ciphertext,
      ...metadata
    } = value;
    return {
      ...metadata,
      value: JSON.parse(
        new TextDecoder().decode(plaintext),
      ) as JsonValue,
    };
  }

  async set(entry: CachedJsonObject): Promise<void> {
    const database = await this.database();
    const deviceKey = await this.deviceKey(database);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128,
      },
      deviceKey,
      new TextEncoder().encode(JSON.stringify(entry.value)),
    );
    const transaction = database.transaction("objects", "readwrite");
    transaction.objectStore("objects").put({
      key: entry.key,
      etag: entry.etag,
      cachedAt: entry.cachedAt,
      checkedAt: entry.checkedAt,
      immutable: entry.immutable,
      cacheKey: this.cacheKey(entry.key),
      namespace: this.namespace,
      iv: copyArrayBuffer(iv),
      ciphertext,
    } satisfies PersistedCacheEntry);
    await transactionToPromise(transaction);
  }

  async delete(key: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction("objects", "readwrite");
    transaction.objectStore("objects").delete(this.cacheKey(key));
    await transactionToPromise(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction("objects", "readwrite");
    const store = transaction.objectStore("objects");
    const index = store.index("namespace");
    const request = index.openKeyCursor(IDBKeyRange.only(this.namespace));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionToPromise(transaction);
  }

  async destroy(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(
      ["objects", "keys"],
      "readwrite",
    );
    const store = transaction.objectStore("objects");
    const index = store.index("namespace");
    const request = index.openKeyCursor(
      IDBKeyRange.only(this.namespace),
    );
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.objectStore("keys").delete(this.deviceKeyId());
    await transactionToPromise(transaction);
    this.deviceKeyPromise = undefined;
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = undefined;
  }

  private cacheKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("objects")) {
          const store = database.createObjectStore("objects", {
            keyPath: "cacheKey",
          });
          store.createIndex("namespace", "namespace", { unique: false });
        }
        if (!database.objectStoreNames.contains("keys")) {
          database.createObjectStore("keys", {
            keyPath: "keyId",
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to open IndexedDB"));
    });
    return this.databasePromise;
  }

  private async deviceKey(database: IDBDatabase): Promise<CryptoKey> {
    this.deviceKeyPromise ??= withCacheKeyLock(
      `${this.databaseName}:${this.deviceKeyId()}`,
      () => this.loadOrCreateDeviceKey(database),
    );
    return this.deviceKeyPromise;
  }

  private async loadOrCreateDeviceKey(
    database: IDBDatabase,
  ): Promise<CryptoKey> {
    const existing = await requestToPromise<
      PersistedDeviceKey | undefined
    >(
      database
        .transaction("keys", "readonly")
        .objectStore("keys")
        .get(this.deviceKeyId()),
    );
    if (existing) {
      return existing.key;
    }

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const transaction = database.transaction("keys", "readwrite");
    transaction.objectStore("keys").put({
      keyId: this.deviceKeyId(),
      key,
    } satisfies PersistedDeviceKey);
    await transactionToPromise(transaction);
    return key;
  }

  private deviceKeyId(): string {
    return `${this.namespace}:device-cache-key`;
  }
}

export class TieredObjectCache {
  private policy: CachePolicy;
  private memoryHits = 0;
  private indexedDbHits = 0;
  private misses = 0;
  private writes = 0;

  constructor(
    private readonly memory: MemoryObjectCache,
    private readonly persistent: IndexedDbObjectCache,
    policy: CachePolicy = "content",
  ) {
    this.policy = policy;
  }

  setPolicy(policy: CachePolicy): void {
    if (policy === this.policy) {
      return;
    }
    this.policy = policy;
    this.memory.clear();
  }

  async get(key: string): Promise<CachedJsonObject | null> {
    if (this.policy === "none") {
      this.misses += 1;
      return null;
    }

    const memoryEntry = this.memory.get(key);
    if (memoryEntry && this.isCacheable(memoryEntry)) {
      this.memoryHits += 1;
      return memoryEntry;
    }

    const persisted = await this.persistent.get(key);
    if (persisted && this.isCacheable(persisted)) {
      this.indexedDbHits += 1;
      this.memory.set(persisted);
      return persisted;
    }

    this.misses += 1;
    return null;
  }

  async set(entry: CachedJsonObject): Promise<void> {
    if (!this.isCacheable(entry)) {
      return;
    }
    this.writes += 1;
    this.memory.set(entry);
    await this.persistent.set(entry);
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    await this.persistent.delete(key);
  }

  clearMemory(): void {
    this.memory.clear();
  }

  async clearAll(): Promise<void> {
    this.memory.clear();
    await this.persistent.clear();
  }

  async destroy(): Promise<void> {
    this.memory.clear();
    await this.persistent.destroy();
  }

  resetMetrics(): void {
    this.memoryHits = 0;
    this.indexedDbHits = 0;
    this.misses = 0;
    this.writes = 0;
  }

  metrics(): BrowserCacheMetrics {
    const memory = this.memory.stats();
    return {
      policy: this.policy,
      memoryHits: this.memoryHits,
      indexedDbHits: this.indexedDbHits,
      misses: this.misses,
      writes: this.writes,
      memoryEntries: memory.entries,
      memoryBytes: memory.bytes,
      evictions: memory.evictions,
    };
  }

  private isCacheable(entry: CachedJsonObject): boolean {
    if (this.policy === "none") {
      return false;
    }
    if (this.policy === "content") {
      return true;
    }
    return isLocationEntry(entry);
  }
}

function isLocationEntry(entry: CachedJsonObject): boolean {
  if (
    entry.key.endsWith("/HEAD.json") ||
    entry.key.endsWith("/current.json") ||
    entry.key.includes("/indexes/")
  ) {
    return true;
  }
  if (
    typeof entry.value !== "object" ||
    entry.value === null ||
    Array.isArray(entry.value) ||
    !("kind" in entry.value)
  ) {
    return false;
  }
  return (
    entry.value.kind === "root" ||
    entry.value.kind === "branch"
  );
}

function estimateEntryBytes(entry: CachedJsonObject): number {
  return (
    new TextEncoder().encode(JSON.stringify(entry.value)).byteLength +
    entry.key.length +
    entry.etag.length +
    48
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionToPromise(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("IndexedDB transaction failed"),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("IndexedDB transaction aborted"),
      );
  });
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

async function withCacheKeyLock<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    typeof navigator !== "undefined" &&
    navigator.locks
  ) {
    return navigator.locks.request(
      `thimbledb-cache-key:${name}`,
      operation,
    );
  }
  return operation();
}
