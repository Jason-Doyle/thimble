import type {
  CachePolicy,
  JsonValue,
} from "../core.js";
import {
  base64ToBytes,
  importAesGcmKey,
} from "../envelope.js";
import type { CollectionLayout } from "../snapshot-protocol.js";
import {
  validateIndexConfiguration,
  type CollectionIndexConfiguration,
} from "../secondary-index.js";
import {
  IndexedDbObjectCache,
  MemoryObjectCache,
  NamespacedMemoryObjectCache,
  NamespacedPersistentObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "./cache.js";
import { ThimbleClient } from "./client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  ScopedJsonObjectReader,
} from "./remote-reader.js";

export type ThimbleAuthorityConfig = {
  name: string;
  provider: "local" | "azure" | "s3" | "r2";
  readBaseUrl: string;
  headTtlMs: number;
  cachePolicy: CachePolicy;
  collectionLayouts: Record<string, CollectionLayout>;
  collectionIndexes: CollectionIndexConfiguration;
  layoutGeneration: string;
  csrfToken: string;
  user: {
    id: string;
    provider: string;
    roles: string[];
    tenants: string[];
    identities: Array<{
      provider: string;
      issuer: string;
      subject: string;
      tenantId?: string;
      displayName?: string;
    }>;
  };
  scope: {
    id: string;
    encrypted: boolean;
    keyId: string | null;
    keyEndpoint: string | null;
  };
};

export type CreateThimbleClientOptions = {
  configurationUrl?: string;
  fetchImplementation?: typeof fetch;
  memoryCache?: MemoryObjectCache;
  persistentCache?: PersistentObjectCache | false;
  indexedDbName?: string;
  channelName?: string;
  layoutCheckTtlMs?: number;
  onLogout?: (error?: unknown) => void;
  onLayoutChange?: () => void;
};

export type ThimbleConnection = {
  client: ThimbleClient;
  config: ThimbleAuthorityConfig;
  cache: TieredObjectCache;
};

export class ThimbleConnectionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ThimbleConnectionError";
  }
}

type ScopeGrant = {
  scopeId: string;
  writeKeyId: string;
  keys: Array<{
    keyId: string;
    key: string;
  }>;
  algorithm: string;
  expiresAt: string;
};

export async function createThimbleClient(
  options: CreateThimbleClientOptions = {},
): Promise<ThimbleClient> {
  return (await createThimbleConnection(options)).client;
}

export async function createThimbleConnection(
  options: CreateThimbleClientOptions = {},
): Promise<ThimbleConnection> {
  const fetchImplementation =
    options.fetchImplementation ?? globalThis.fetch;
  if (!fetchImplementation) {
    throw new Error("ThimbleDB connection requires fetch");
  }

  const configurationUrl = new URL(
    options.configurationUrl ?? "/api/config",
    globalThis.location?.href ?? "http://127.0.0.1/",
  );
  const response = await fetchImplementation.call(
    globalThis,
    configurationUrl,
    {
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new ThimbleConnectionError(
      `ThimbleDB configuration request failed with ${response.status}`,
      response.status,
    );
  }
  const config = validateConfig(await response.json());
  const scopeKeys = await loadScopeKeys(
    config,
    configurationUrl,
    fetchImplementation,
  );
  const readBaseUrl = new URL(
    config.readBaseUrl,
    configurationUrl,
  ).toString();
  const namespace = [
    config.provider,
    new URL(readBaseUrl).origin,
    new URL(readBaseUrl).pathname,
    config.scope.id,
  ].join(":");
  const sessionNamespace = [
    config.provider,
    new URL(readBaseUrl).origin,
    new URL(readBaseUrl).pathname,
  ].join(":");
  const registry =
    options.persistentCache === undefined &&
    typeof indexedDB !== "undefined"
      ? new CacheNamespaceRegistry(
          sessionNamespace,
          options.indexedDbName,
        )
      : null;
  registry?.register(namespace);
  const memory = new NamespacedMemoryObjectCache(
    namespace,
    options.memoryCache ?? new MemoryObjectCache(),
  );
  const persistent =
    options.persistentCache === false
      ? new NullPersistentObjectCache()
      : options.persistentCache
        ? new NamespacedPersistentObjectCache(
            namespace,
            options.persistentCache,
          )
        : typeof indexedDB === "undefined"
          ? new NullPersistentObjectCache()
          : new IndexedDbObjectCache(
              namespace,
              options.indexedDbName,
            );
  const cache = new TieredObjectCache(
    memory,
    persistent,
    config.cachePolicy,
  );
  const reader = new ScopedJsonObjectReader(
    new EnvelopeJsonObjectReader(
      new HttpByteObjectReader(
        readBaseUrl,
        fetchImplementation,
        configurationUrl.toString(),
      ),
      scopeKeys
        ? (keyId) => scopeKeys.keys.get(keyId) ?? null
        : undefined,
    ),
    config.scope.id,
  );
  const client = new ThimbleClient({
    reader,
    cache,
    headTtlMs: config.headTtlMs,
    csrfToken: config.csrfToken,
    scopeId: config.scope.id,
    scopeKeyId: config.scope.keyId,
    writeBaseUrl: configurationUrl.origin,
    fetchImplementation,
    ...(scopeKeys
      ? { keyExpiresAt: scopeKeys.expiresAt }
      : {}),
    channelName:
      options.channelName ?? `thimbledb:${namespace}`,
    sessionChannelName:
      `thimbledb-session:${sessionNamespace}`,
    ...(options.onLogout
      ? { onLogout: options.onLogout }
      : {}),
    collectionLayouts: config.collectionLayouts,
    collectionIndexes: config.collectionIndexes,
    layoutGeneration: config.layoutGeneration,
    configurationUrl: configurationUrl.toString(),
    layoutCheckTtlMs: options.layoutCheckTtlMs ?? 1_000,
    onLayoutChange:
      options.onLayoutChange ??
      (() => globalThis.location?.reload()),
    ...(registry
      ? {
          onCacheDestroyed: () =>
            registry.unregister(namespace),
          onAuthorityLogout: () => registry.destroyAll(),
        }
      : {}),
  });

  return { client, config, cache };
}

async function loadScopeKeys(
  config: ThimbleAuthorityConfig,
  configurationUrl: URL,
  fetchImplementation: typeof fetch,
): Promise<{
  keys: Map<string, CryptoKey>;
  expiresAt: string;
} | null> {
  if (!config.scope.encrypted) {
    return null;
  }
  if (!config.scope.keyId || !config.scope.keyEndpoint) {
    throw new Error(
      "Encrypted scope is missing its key grant endpoint",
    );
  }
  const response = await fetchImplementation.call(
    globalThis,
    new URL(config.scope.keyEndpoint, configurationUrl),
    {
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new ThimbleConnectionError(
      `Scope key request failed with ${response.status}`,
      response.status,
    );
  }
  const grant = validateGrant(await response.json());
  if (
    grant.scopeId !== config.scope.id ||
    grant.writeKeyId !== config.scope.keyId
  ) {
    throw new Error(
      "Scope key grant does not match authority configuration",
    );
  }
  const keys = new Map<string, CryptoKey>();
  for (const granted of grant.keys) {
    const raw = base64ToBytes(granted.key);
    granted.key = "";
    keys.set(
      granted.keyId,
      await importAesGcmKey(raw, ["decrypt"], false),
    );
    raw.fill(0);
  }
  if (!keys.has(grant.writeKeyId)) {
    throw new Error("Scope key grant omitted the write key");
  }
  return { keys, expiresAt: grant.expiresAt };
}

function validateConfig(value: unknown): ThimbleAuthorityConfig {
  if (!isRecord(value)) {
    throw new Error("ThimbleDB configuration must be an object");
  }
  const scope = value.scope;
  const user = value.user;
  if (
    typeof value.name !== "string" ||
    !isProvider(value.provider) ||
    typeof value.readBaseUrl !== "string" ||
    typeof value.headTtlMs !== "number" ||
    !Number.isFinite(value.headTtlMs) ||
    value.headTtlMs < 0 ||
    !isCachePolicy(value.cachePolicy) ||
    !isRecord(value.collectionLayouts) ||
    typeof value.layoutGeneration !== "string" ||
    value.layoutGeneration.length === 0 ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length === 0 ||
    !isRecord(scope) ||
    typeof scope.id !== "string" ||
    scope.id.length === 0 ||
    typeof scope.encrypted !== "boolean" ||
    !isNullableString(scope.keyId) ||
    !isNullableString(scope.keyEndpoint) ||
    !isRecord(user) ||
    typeof user.id !== "string" ||
    typeof user.provider !== "string" ||
    !isStringArray(user.roles) ||
    !isStringArray(user.tenants) ||
    !Array.isArray(user.identities) ||
    !user.identities.every(isIdentity)
  ) {
    throw new Error("ThimbleDB configuration is malformed");
  }
  for (const layout of Object.values(value.collectionLayouts)) {
    if (layout !== "trie" && layout !== "snapshot") {
      throw new Error("ThimbleDB collection layout is malformed");
    }
  }
  const collectionIndexes = validateIndexConfiguration(
    isRecord(value.collectionIndexes)
      ? (value.collectionIndexes as CollectionIndexConfiguration)
      : {},
  );
  return {
    ...(value as unknown as ThimbleAuthorityConfig),
    collectionIndexes,
  };
}

function validateGrant(value: unknown): ScopeGrant {
  if (
    !isRecord(value) ||
    typeof value.scopeId !== "string" ||
    typeof value.writeKeyId !== "string" ||
    value.algorithm !== "A256GCM" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.keys) ||
    !value.keys.every(
      (key) =>
        isRecord(key) &&
        typeof key.keyId === "string" &&
        key.keyId.length > 0 &&
        typeof key.key === "string" &&
        key.key.length > 0,
    )
  ) {
    throw new Error("Scope key grant is malformed");
  }
  const keyIds = value.keys.map((key) => key.keyId);
  if (new Set(keyIds).size !== keyIds.length) {
    throw new Error("Scope key grant contains duplicate keys");
  }
  return value as ScopeGrant;
}

function isRecord(
  value: unknown,
): value is Record<string, JsonValue | unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.issuer === "string" &&
    typeof value.subject === "string" &&
    (value.tenantId === undefined ||
      typeof value.tenantId === "string") &&
    (value.displayName === undefined ||
      typeof value.displayName === "string")
  );
}

function isProvider(
  value: unknown,
): value is ThimbleAuthorityConfig["provider"] {
  return (
    value === "local" ||
    value === "azure" ||
    value === "s3" ||
    value === "r2"
  );
}

function isCachePolicy(value: unknown): value is CachePolicy {
  return (
    value === "none" ||
    value === "locations" ||
    value === "content"
  );
}

function isNullableString(
  value: unknown,
): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

class NullPersistentObjectCache implements PersistentObjectCache {
  get(): Promise<null> {
    return Promise.resolve(null);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

class CacheNamespaceRegistry {
  private readonly key: string;

  constructor(
    private readonly authorityNamespace: string,
    private readonly databaseName?: string,
  ) {
    this.key =
      `thimbledb-cache-registry:${authorityNamespace}` +
      (databaseName ? `:${databaseName}` : "");
  }

  register(namespace: string): void {
    const namespaces = this.namespaces();
    namespaces.add(namespace);
    this.write(namespaces);
  }

  unregister(namespace: string): void {
    const namespaces = this.namespaces();
    namespaces.delete(namespace);
    this.write(namespaces);
  }

  async destroyAll(): Promise<void> {
    await IndexedDbObjectCache.destroyNamespaces(
      `${this.authorityNamespace}:`,
      this.databaseName,
    );
    this.write(new Set());
  }

  private namespaces(): Set<string> {
    const storage = safeLocalStorage();
    if (!storage) {
      return new Set();
    }
    const encoded = storage.getItem(this.key);
    if (!encoded) {
      return new Set();
    }
    try {
      const parsed = JSON.parse(encoded) as unknown;
      return Array.isArray(parsed)
        ? new Set(
            parsed.filter(
              (value): value is string =>
                typeof value === "string",
            ),
          )
        : new Set();
    } catch {
      return new Set();
    }
  }

  private write(namespaces: Set<string>): void {
    const storage = safeLocalStorage();
    if (!storage) {
      return;
    }
    if (namespaces.size === 0) {
      storage.removeItem(this.key);
      return;
    }
    storage.setItem(
      this.key,
      JSON.stringify([...namespaces].sort()),
    );
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined"
      ? null
      : localStorage;
  } catch {
    return null;
  }
}
