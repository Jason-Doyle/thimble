export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonDocument = {
  id: string;
  [key: string]: JsonValue;
};

export type StoredObject = {
  bytes: Uint8Array;
  etag: string;
};

export type PutConditions = {
  ifMatch?: string;
  ifNoneMatch?: boolean;
};

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class PreconditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionFailedError";
  }
}

export class BoundedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedReadError";
  }
}

export type EngineDiagnostics = Record<string, number>;

export interface DatabaseEngine {
  readonly name: string;
  get(collection: string, id: string): Promise<JsonDocument | null>;
  scan(collection: string): Promise<JsonDocument[]>;
  put(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void>;
  putMany(collection: string, documents: JsonDocument[]): Promise<void>;
  compact(collection: string): Promise<void>;
  diagnostics(): EngineDiagnostics;
}

export type OperationMetric = {
  count: number;
  bytes: number;
  durationMs: number;
};

export type StoreMetrics = {
  get: OperationMetric;
  put: OperationMetric;
  delete: OperationMetric;
  list: OperationMetric;
  preconditionFailures: number;
};

export type CacheMetrics = {
  policy: CachePolicy;
  hits: number;
  misses: number;
  expired: number;
  evictions: number;
  entries: number;
  bytes: number;
};

export type CachePolicy = "none" | "locations" | "content";

export type DeletionPolicy = {
  restoreWindowMs: number;
  purgeGraceMs: number;
  now?: Date;
};
