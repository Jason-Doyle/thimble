import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  PreconditionFailedError,
  type CacheMetrics,
  type CachePolicy,
  type ObjectStore,
  type PutConditions,
  type StoredObject,
  type StoreMetrics,
} from "./core.js";
export { PrefixObjectStore } from "./prefix-store.js";
import { sha256, sleep } from "./utils.js";

function normalizeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Invalid object key: ${key}`);
  }
  return normalized;
}

function emptyMetrics(): StoreMetrics {
  return {
    get: { count: 0, bytes: 0, durationMs: 0 },
    put: { count: 0, bytes: 0, durationMs: 0 },
    delete: { count: 0, bytes: 0, durationMs: 0 },
    list: { count: 0, bytes: 0, durationMs: 0 },
    preconditionFailures: 0,
  };
}

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async get(key: string): Promise<StoredObject | null> {
    const normalized = normalizeObjectKey(key);
    return this.withKeyLock(normalized, () =>
      this.readUnlocked(normalized),
    );
  }

  private async readUnlocked(
    normalized: string,
  ): Promise<StoredObject | null> {
    const objectPath = this.resolveKey(normalized);
    try {
      const bytes = await readFile(objectPath);
      return { bytes, etag: sha256(bytes) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ): Promise<{ etag: string }> {
    const normalized = normalizeObjectKey(key);
    return this.withKeyLock(normalized, async () => {
      const current = await this.readUnlocked(normalized);
      if (conditions.ifNoneMatch && current !== null) {
        throw new PreconditionFailedError(
          `Object already exists: ${normalized}`,
        );
      }
      if (
        conditions.ifMatch !== undefined &&
        current?.etag !== conditions.ifMatch
      ) {
        throw new PreconditionFailedError(
          `ETag does not match for ${normalized}`,
        );
      }

      const objectPath = this.resolveKey(normalized);
      await mkdir(path.dirname(objectPath), { recursive: true });
      await writeFile(objectPath, bytes);
      return { etag: sha256(bytes) };
    });
  }

  async delete(key: string): Promise<void> {
    const normalized = normalizeObjectKey(key);
    await this.withKeyLock(normalized, async () => {
      await rm(this.resolveKey(normalized), { force: true });
    });
  }

  async list(prefix: string): Promise<string[]> {
    const normalizedPrefix = prefix
      ? normalizeObjectKey(prefix).replace(/\/+$/, "")
      : "";
    const startPath = normalizedPrefix
      ? this.resolveKey(normalizedPrefix)
      : this.root;
    const keys: string[] = [];

    try {
      await walkFiles(startPath, async (filePath) => {
        keys.push(
          path
            .relative(this.root, filePath)
            .split(path.sep)
            .join("/"),
        );
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return keys.sort();
  }

  private resolveKey(key: string): string {
    const normalized = normalizeObjectKey(key);
    const resolved = path.resolve(this.root, ...normalized.split("/"));
    const rootPrefix = `${this.root}${path.sep}`;
    if (!resolved.startsWith(rootPrefix)) {
      throw new Error(`Object key escapes storage root: ${key}`);
    }
    return resolved;
  }

  private async withKeyLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.queues.get(key) === queued) {
        this.queues.delete(key);
      }
    }
  }
}

export class AzureBlobObjectStore implements ObjectStore {
  private readonly container: ContainerClient;
  private ready: Promise<unknown> | undefined;

  constructor(connectionString: string, containerName: string) {
    this.container =
      BlobServiceClient.fromConnectionString(
        connectionString,
      ).getContainerClient(containerName);
  }

  async get(key: string): Promise<StoredObject | null> {
    await this.ensureContainer();
    try {
      const response = await this.container
        .getBlobClient(normalizeObjectKey(key))
        .download();
      if (!response.readableStreamBody || !response.etag) {
        throw new Error(`Azure returned an incomplete response for ${key}`);
      }
      return {
        bytes: await streamToBytes(response.readableStreamBody),
        etag: response.etag,
      };
    } catch (error) {
      if (httpStatus(error) === 404) {
        return null;
      }
      throw mapPreconditionError(error, key);
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ): Promise<{ etag: string }> {
    await this.ensureContainer();
    const requestConditions: {
      ifMatch?: string;
      ifNoneMatch?: string;
    } = {};
    if (conditions.ifMatch !== undefined) {
      requestConditions.ifMatch = conditions.ifMatch;
    }
    if (conditions.ifNoneMatch) {
      requestConditions.ifNoneMatch = "*";
    }

    try {
      const response = await this.container
        .getBlockBlobClient(normalizeObjectKey(key))
        .uploadData(Buffer.from(bytes), {
          conditions: requestConditions,
        });
      if (!response.etag) {
        throw new Error(`Azure did not return an ETag for ${key}`);
      }
      return { etag: response.etag };
    } catch (error) {
      throw mapPreconditionError(error, key);
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureContainer();
    await this.container
      .getBlockBlobClient(normalizeObjectKey(key))
      .deleteIfExists();
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureContainer();
    const keys: string[] = [];
    const normalizedPrefix = prefix
      ? normalizeObjectKey(prefix).replace(/\/+$/, "")
      : "";
    for await (const blob of this.container.listBlobsFlat({
      prefix: normalizedPrefix,
    })) {
      keys.push(blob.name);
    }
    return keys.sort();
  }

  private ensureContainer(): Promise<unknown> {
    this.ready ??= this.container.createIfNotExists();
    return this.ready;
  }
}

export type S3ObjectStoreOptions = {
  bucket: string;
  clientConfig?: S3ClientConfig;
};

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client(options.clientConfig ?? {});
  }

  async get(key: string): Promise<StoredObject | null> {
    const normalized = normalizeObjectKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: normalized,
        }),
      );
      if (!response.Body || !response.ETag) {
        throw new Error(`S3 returned an incomplete response for ${key}`);
      }
      return {
        bytes: await response.Body.transformToByteArray(),
        etag: response.ETag,
      };
    } catch (error) {
      if (httpStatus(error) === 404 || errorName(error) === "NoSuchKey") {
        return null;
      }
      throw mapPreconditionError(error, key);
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ): Promise<{ etag: string }> {
    const input: {
      Bucket: string;
      Key: string;
      Body: Uint8Array;
      IfMatch?: string;
      IfNoneMatch?: string;
    } = {
      Bucket: this.bucket,
      Key: normalizeObjectKey(key),
      Body: bytes,
    };
    if (conditions.ifMatch !== undefined) {
      input.IfMatch = conditions.ifMatch;
    }
    if (conditions.ifNoneMatch) {
      input.IfNoneMatch = "*";
    }

    try {
      const response = await this.client.send(new PutObjectCommand(input));
      if (!response.ETag) {
        throw new Error(`S3 did not return an ETag for ${key}`);
      }
      return { etag: response.ETag };
    } catch (error) {
      throw mapPreconditionError(error, key);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: normalizeObjectKey(key),
      }),
    );
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    const normalizedPrefix = prefix
      ? normalizeObjectKey(prefix).replace(/\/+$/, "")
      : "";

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: normalizedPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) {
          keys.push(item.Key);
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys.sort();
  }
}

export class MeteredObjectStore implements ObjectStore {
  private metrics = emptyMetrics();

  constructor(
    private readonly delegate: ObjectStore,
    private readonly latencyMs = 0,
  ) {}

  async get(key: string): Promise<StoredObject | null> {
    const started = performance.now();
    await sleep(this.latencyMs);
    try {
      const result = await this.delegate.get(key);
      this.metrics.get.bytes += result?.bytes.byteLength ?? 0;
      return result;
    } finally {
      this.metrics.get.count += 1;
      this.metrics.get.durationMs += performance.now() - started;
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    const started = performance.now();
    await sleep(this.latencyMs);
    try {
      const result = await this.delegate.put(key, bytes, conditions);
      this.metrics.put.bytes += bytes.byteLength;
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "PreconditionFailedError"
      ) {
        this.metrics.preconditionFailures += 1;
      }
      throw error;
    } finally {
      this.metrics.put.count += 1;
      this.metrics.put.durationMs += performance.now() - started;
    }
  }

  async delete(key: string): Promise<void> {
    const started = performance.now();
    await sleep(this.latencyMs);
    try {
      await this.delegate.delete(key);
    } finally {
      this.metrics.delete.count += 1;
      this.metrics.delete.durationMs += performance.now() - started;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const started = performance.now();
    await sleep(this.latencyMs);
    try {
      const keys = await this.delegate.list(prefix);
      this.metrics.list.bytes += keys.reduce(
        (total, key) => total + Buffer.byteLength(key),
        0,
      );
      return keys;
    } finally {
      this.metrics.list.count += 1;
      this.metrics.list.durationMs += performance.now() - started;
    }
  }

  snapshot(reset = false): StoreMetrics {
    const snapshot = structuredClone(this.metrics);
    if (reset) {
      this.metrics = emptyMetrics();
    }
    return snapshot;
  }

  reset(): void {
    this.metrics = emptyMetrics();
  }
}

type CacheEntry = {
  object: StoredObject;
  expiresAt: number | null;
};

export class CachedObjectStore implements ObjectStore {
  private readonly cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private expired = 0;
  private evictions = 0;
  private bytes = 0;
  private policy: CachePolicy = "content";

  constructor(
    private readonly delegate: ObjectStore,
    private readonly options: {
      mutableTtlMs: number;
      maxBytes: number;
      maxEntries: number;
    },
  ) {}

  async get(key: string): Promise<StoredObject | null> {
    if (this.policy === "none") {
      this.misses += 1;
      return this.delegate.get(key);
    }

    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt === null || cached.expiresAt > Date.now()) {
        this.hits += 1;
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.object;
      }
      this.expired += 1;
      this.remove(key);
    }

    this.misses += 1;
    const object = await this.delegate.get(key);
    if (object !== null && this.isCacheable(key, object.bytes)) {
      this.set(key, object);
    }
    return object;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    try {
      const result = await this.delegate.put(key, bytes, conditions);
      if (this.isCacheable(key, bytes)) {
        this.set(key, { bytes, etag: result.etag });
      } else {
        this.remove(key);
      }
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "PreconditionFailedError"
      ) {
        this.remove(key);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.delegate.delete(key);
    this.remove(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.delegate.list(prefix);
  }

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
  }

  setPolicy(policy: CachePolicy): void {
    if (this.policy === policy) {
      return;
    }
    this.policy = policy;
    this.clear();
  }

  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.expired = 0;
    this.evictions = 0;
  }

  snapshot(reset = false): CacheMetrics {
    const snapshot: CacheMetrics = {
      policy: this.policy,
      hits: this.hits,
      misses: this.misses,
      expired: this.expired,
      evictions: this.evictions,
      entries: this.cache.size,
      bytes: this.bytes,
    };
    if (reset) {
      this.resetMetrics();
    }
    return snapshot;
  }

  private set(key: string, object: StoredObject): void {
    this.remove(key);
    const immutable = isImmutableObjectKey(key);
    this.cache.set(key, {
      object,
      expiresAt: immutable
        ? null
        : Date.now() + this.options.mutableTtlMs,
    });
    this.bytes += object.bytes.byteLength;
    this.evictIfNeeded();
  }

  private isCacheable(key: string, bytes: Uint8Array): boolean {
    if (this.policy === "none") {
      return false;
    }
    if (this.policy === "content") {
      return true;
    }
    return isLocationObject(key, bytes);
  }

  private remove(key: string): void {
    const existing = this.cache.get(key);
    if (!existing) {
      return;
    }
    this.bytes -= existing.object.bytes.byteLength;
    this.cache.delete(key);
  }

  private evictIfNeeded(): void {
    while (
      this.cache.size > this.options.maxEntries ||
      this.bytes > this.options.maxBytes
    ) {
      const oldestKey = this.cache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) {
        return;
      }
      this.remove(oldestKey);
      this.evictions += 1;
    }
  }
}

async function walkFiles(
  directory: string,
  visit: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walkFiles(entryPath, visit);
      } else if (entry.isFile()) {
        await visit(entryPath);
      }
    }),
  );
}

async function streamToBytes(
  stream: NodeJS.ReadableStream,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function mapPreconditionError(error: unknown, key: string): Error {
  const status = httpStatus(error);
  if (status === 409 || status === 412) {
    return new PreconditionFailedError(
      `Conditional object write failed for ${key}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
  ) {
    return error.$metadata.httpStatusCode;
  }
  return undefined;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isImmutableObjectKey(key: string): boolean {
  return (
    key.includes("/nodes/") ||
    key.includes("/log/") ||
    key.includes("/snapshots/")
  );
}

function isLocationObject(key: string, bytes: Uint8Array): boolean {
  if (
    key.endsWith("/HEAD.json") ||
    key.endsWith("/current.json") ||
    key.includes("/indexes/")
  ) {
    return true;
  }
  if (!key.includes("/nodes/")) {
    return false;
  }

  try {
    const node = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      kind?: string;
    };
    return node.kind === "root" || node.kind === "branch";
  } catch {
    return false;
  }
}
