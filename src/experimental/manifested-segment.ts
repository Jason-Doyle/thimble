import type {
  DatabaseEngine,
  EngineDiagnostics,
  JsonDocument,
  JsonPrimitive,
  JsonValue,
  ObjectStore,
  StoredObject,
} from "../core.js";
import { bytesToBase64, base64ToBytes } from "../envelope.js";
import {
  createDictionary,
  decodeJson,
  isPreconditionFailure,
  ownValue,
  validateName,
} from "../shared-utils.js";
import {
  encodeCanonicalJson,
  type IndexedSegmentField,
  type IndexedSegmentPredicate,
  type IndexedSegmentQueryResult,
} from "./indexed-segment.js";

const DEFAULT_TARGET_BLOCK_BYTES = 256 * 1024;
const MIN_TARGET_BLOCK_BYTES = 16 * 1024;
const MAX_TARGET_BLOCK_BYTES = 1024 * 1024;
const MAX_BLOCKS = 10_000;
const MAX_FIELDS = 8;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const BLOOM_BYTES = 32;
const READ_CONCURRENCY = 6;

export type ManifestedSegmentOptions = {
  targetBlockBytes?: number;
  collectionFields?: Record<string, IndexedSegmentField[]>;
  maxRetries?: number;
  addressBlock?: (
    bytes: Uint8Array,
  ) => Promise<string> | string;
};

type ScalarKind =
  | "none"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "mixed";

type FieldStats = {
  kind: ScalarKind;
  bloom: string;
  min?: JsonPrimitive;
  max?: JsonPrimitive;
};

export type ManifestedBlockReference = {
  hash: string;
  firstId: string;
  lastId: string;
  records: number;
  decodedBytes: number;
  stats: FieldStats[];
};

export type ManifestedSegmentHead = {
  version: 1;
  revision: number;
  fields: IndexedSegmentField[];
  blocks: ManifestedBlockReference[];
};

type ManifestedBlockPage = {
  version: 1;
  documents: JsonDocument[];
};

type LoadedHead = {
  state: ManifestedSegmentHead;
  object: StoredObject | null;
};

export class ExperimentalManifestedSegmentEngine
implements DatabaseEngine {
  readonly name = "experimental-manifested-segment";
  private casRetries = 0;
  private blocksCreated = 0;
  private blocksReused = 0;

  constructor(
    private readonly store: ObjectStore,
    private readonly options: ManifestedSegmentOptions = {},
  ) {
    const target =
      options.targetBlockBytes ?? DEFAULT_TARGET_BLOCK_BYTES;
    if (
      !Number.isInteger(target) ||
      target < MIN_TARGET_BLOCK_BYTES ||
      target > MAX_TARGET_BLOCK_BYTES
    ) {
      throw new Error(
        `Manifested segment block size must be ${MIN_TARGET_BLOCK_BYTES}-${MAX_TARGET_BLOCK_BYTES}`,
      );
    }
  }

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    const normalized = validateName(collection, "Collection");
    const loaded = await this.loadHead(normalized);
    const position = findBlockPosition(
      loaded.state.blocks,
      id,
    );
    if (position === -1) {
      return null;
    }
    const block = await this.readBlock(
      normalized,
      loaded.state.blocks[position]!,
    );
    return (
      block.documents.find(
        (document) => document.id === id,
      ) ?? null
    );
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const normalized = validateName(collection, "Collection");
    const loaded = await this.loadHead(normalized);
    const blocks = await mapConcurrent(
      loaded.state.blocks,
      READ_CONCURRENCY,
      (reference) =>
        this.readBlock(normalized, reference),
    );
    return blocks.flatMap((block) => block.documents);
  }

  put(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void> {
    if (id !== document.id) {
      return Promise.reject(
        new Error("Document id does not match the storage key"),
      );
    }
    return this.mutate(collection, id, document);
  }

  async putMany(
    collection: string,
    documents: JsonDocument[],
  ): Promise<void> {
    const normalized = validateName(collection, "Collection");
    const current = new Map<string, JsonDocument>();
    for (const document of documents) {
      validateDocument(document);
      current.set(document.id, snapshot(document));
    }
    const sorted = [...current.values()].sort(compareDocuments);
    const references = await this.writeBlocks(
      normalized,
      partitionDocuments(
        sorted,
        this.targetBlockBytes(),
      ),
      this.fieldsFor(normalized),
    );
    const head: ManifestedSegmentHead = {
      version: 1,
      revision: 1,
      fields: this.fieldsFor(normalized),
      blocks: references,
    };
    const existing = await this.store.get(
      manifestedHeadKey(normalized),
    );
    await this.store.put(
      manifestedHeadKey(normalized),
      encodeCanonicalJson(head as unknown as JsonValue),
      existing
        ? { ifMatch: existing.etag }
        : { ifNoneMatch: true },
    );
  }

  compact(_collection: string): Promise<void> {
    return Promise.resolve();
  }

  async query(
    collection: string,
    predicate: IndexedSegmentPredicate,
    limit = 1_000_000,
  ): Promise<IndexedSegmentQueryResult> {
    const normalized = validateName(collection, "Collection");
    const loaded = await this.loadHead(normalized);
    const fieldIndex = loaded.state.fields.findIndex(
      (field) => field.field === predicate.field,
    );
    const configured =
      fieldIndex >= 0
        ? loaded.state.fields[fieldIndex]
        : undefined;
    const canFilter =
      configured !== undefined &&
      (predicate.operator === "eq" ||
        configured.mode === "range");
    const equalityHash =
      predicate.operator === "eq"
        ? await scalarHash(predicate.value)
        : null;
    const selected = loaded.state.blocks.filter(
      (block) =>
        !canFilter ||
        blockMayMatch(
          block.stats[fieldIndex]!,
          predicate,
          equalityHash,
        ),
    );
    const pages = await mapConcurrent(
      selected,
      READ_CONCURRENCY,
      (reference) =>
        this.readBlock(normalized, reference),
    );
    const documents: JsonDocument[] = [];
    for (const page of pages) {
      for (const document of page.documents) {
        if (documentMatches(document, predicate)) {
          documents.push(document);
          if (documents.length >= limit) {
            return result(
              documents,
              canFilter,
              loaded.state.blocks.length,
              selected.length,
            );
          }
        }
      }
    }
    return result(
      documents,
      canFilter,
      loaded.state.blocks.length,
      selected.length,
    );
  }

  diagnostics(): EngineDiagnostics {
    return {
      casRetries: this.casRetries,
      blocksCreated: this.blocksCreated,
      blocksReused: this.blocksReused,
    };
  }

  private async mutate(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void> {
    const normalized = validateName(collection, "Collection");
    validateDocument(document);
    const replacement = snapshot(document);
    const attempts = this.options.maxRetries ?? 40;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const loaded = await this.loadHead(normalized);
      const blocks = loaded.state.blocks;
      const position = insertionBlockPosition(blocks, id);
      const currentDocuments =
        position === -1
          ? []
          : (
              await this.readBlock(
                normalized,
                blocks[position]!,
              )
            ).documents;
      const documents = new Map(
        currentDocuments.map(
          (value) => [value.id, value] as const,
        ),
      );
      documents.set(id, replacement);
      const rewritten = await this.writeBlocks(
        normalized,
        partitionDocuments(
          [...documents.values()].sort(compareDocuments),
          this.targetBlockBytes(),
        ),
        loaded.state.fields,
      );
      const nextBlocks =
        position === -1
          ? rewritten
          : [
              ...blocks.slice(0, position),
              ...rewritten,
              ...blocks.slice(position + 1),
            ];
      validateReferences(nextBlocks);
      const next: ManifestedSegmentHead = {
        version: 1,
        revision: loaded.state.revision + 1,
        fields: loaded.state.fields,
        blocks: nextBlocks,
      };
      try {
        await this.store.put(
          manifestedHeadKey(normalized),
          encodeCanonicalJson(next as unknown as JsonValue),
          loaded.object
            ? { ifMatch: loaded.object.etag }
            : { ifNoneMatch: true },
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
      `Manifested segment write exceeded ${attempts} retries`,
    );
  }

  private async loadHead(
    collection: string,
  ): Promise<LoadedHead> {
    const object = await this.store.get(
      manifestedHeadKey(collection),
    );
    if (!object) {
      return {
        object: null,
        state: {
          version: 1,
          revision: 0,
          fields: this.fieldsFor(collection),
          blocks: [],
        },
      };
    }
    const state = parseHead(decodeJson(object.bytes));
    const configured = this.fieldsFor(collection);
    if (
      JSON.stringify(state.fields) !==
      JSON.stringify(configured)
    ) {
      throw new Error(
        "Manifested segment field configuration changed",
      );
    }
    return { object, state };
  }

  private async readBlock(
    collection: string,
    reference: ManifestedBlockReference,
  ): Promise<ManifestedBlockPage> {
    const object = await this.store.get(
      manifestedBlockKey(collection, reference.hash),
    );
    if (!object) {
      throw new Error(
        `Manifested segment block ${reference.hash} is missing`,
      );
    }
    const page = parseBlock(decodeJson(object.bytes));
    if (
      page.documents.length !== reference.records ||
      page.documents[0]?.id !== reference.firstId ||
      page.documents.at(-1)?.id !== reference.lastId
    ) {
      throw new Error(
        "Manifested segment block metadata does not match",
      );
    }
    return page;
  }

  private async writeBlocks(
    collection: string,
    groups: JsonDocument[][],
    fields: IndexedSegmentField[],
  ): Promise<ManifestedBlockReference[]> {
    return Promise.all(
      groups.map(async (documents) => {
        const page: ManifestedBlockPage = {
          version: 1,
          documents,
        };
        const bytes = encodeCanonicalJson(
          page as unknown as JsonValue,
        );
        const hash = await this.addressBlock(bytes);
        try {
          await this.store.put(
            manifestedBlockKey(collection, hash),
            bytes,
            { ifNoneMatch: true },
          );
          this.blocksCreated += 1;
        } catch (error) {
          if (!isPreconditionFailure(error)) {
            throw error;
          }
          this.blocksReused += 1;
        }
        return {
          hash,
          firstId: documents[0]!.id,
          lastId: documents.at(-1)!.id,
          records: documents.length,
          decodedBytes: bytes.byteLength,
          stats: await Promise.all(
            fields.map((field) =>
              fieldStats(documents, field),
            ),
          ),
        };
      }),
    );
  }

  private fieldsFor(
    collection: string,
  ): IndexedSegmentField[] {
    const source = this.options.collectionFields;
    const fields =
      source && Object.hasOwn(source, collection)
        ? source[collection] ?? []
        : [];
    return validateFields(fields);
  }

  private targetBlockBytes(): number {
    return (
      this.options.targetBlockBytes ??
      DEFAULT_TARGET_BLOCK_BYTES
    );
  }

  private addressBlock(bytes: Uint8Array): Promise<string> {
    return Promise.resolve(
      this.options.addressBlock
        ? this.options.addressBlock(bytes)
        : sha256Hex(bytes),
    );
  }
}

export function manifestedHeadKey(collection: string): string {
  return `manifested-segment/${collection}/HEAD.json`;
}

export function manifestedBlockKey(
  collection: string,
  hash: string,
): string {
  return `manifested-segment/${collection}/blocks/${hash}.json`;
}

function result(
  documents: JsonDocument[],
  filtered: boolean,
  blocks: number,
  read: number,
): IndexedSegmentQueryResult {
  return {
    documents,
    plan: filtered ? "block-filter" : "scan",
    blocksConsidered: blocks,
    blocksRead: read,
    blocksSkipped: blocks - read,
  };
}

function partitionDocuments(
  documents: JsonDocument[],
  targetBytes: number,
): JsonDocument[][] {
  if (documents.length === 0) {
    return [];
  }
  const groups: JsonDocument[][] = [];
  let current: JsonDocument[] = [];
  let bytes = 0;
  for (const document of documents) {
    const documentBytes = encodeCanonicalJson(
      document,
    ).byteLength;
    if (documentBytes > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Manifested segment document ${document.id} is too large`,
      );
    }
    if (
      current.length > 0 &&
      bytes + documentBytes > targetBytes
    ) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(document);
    bytes += documentBytes;
  }
  groups.push(current);
  if (groups.length > MAX_BLOCKS) {
    throw new Error(
      `Manifested segment exceeds ${MAX_BLOCKS} blocks`,
    );
  }
  return groups;
}

function insertionBlockPosition(
  blocks: ManifestedBlockReference[],
  id: string,
): number {
  if (blocks.length === 0) {
    return -1;
  }
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (blocks[middle]!.lastId < id) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.min(low, blocks.length - 1);
}

function findBlockPosition(
  blocks: ManifestedBlockReference[],
  id: string,
): number {
  if (blocks.length === 0) {
    return -1;
  }
  const position = insertionBlockPosition(blocks, id);
  const block = blocks[position]!;
  return id >= block.firstId && id <= block.lastId
    ? position
    : -1;
}

function validateReferences(
  blocks: ManifestedBlockReference[],
): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (
      block.firstId > block.lastId ||
      block.records < 1 ||
      (index > 0 &&
        blocks[index - 1]!.lastId >= block.firstId)
    ) {
      throw new Error(
        "Manifested segment block ranges overlap or are invalid",
      );
    }
  }
}

function parseHead(value: unknown): ManifestedSegmentHead {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Manifested segment HEAD is malformed");
  }
  const candidate = value as {
    version?: unknown;
    revision?: unknown;
    fields?: unknown;
    blocks?: unknown;
  };
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    !Array.isArray(candidate.fields) ||
    !Array.isArray(candidate.blocks)
  ) {
    throw new Error("Manifested segment HEAD is malformed");
  }
  const fields = validateFields(
    candidate.fields as IndexedSegmentField[],
  );
  const blocks = candidate.blocks.map(parseReference);
  validateReferences(blocks);
  return {
    version: 1,
    revision: candidate.revision as number,
    fields,
    blocks,
  };
}

function parseReference(value: unknown): ManifestedBlockReference {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Manifested segment block reference is malformed",
    );
  }
  const candidate = value as ManifestedBlockReference;
  if (
    typeof candidate.hash !== "string" ||
    typeof candidate.firstId !== "string" ||
    typeof candidate.lastId !== "string" ||
    !Number.isSafeInteger(candidate.records) ||
    !Number.isSafeInteger(candidate.decodedBytes) ||
    !Array.isArray(candidate.stats)
  ) {
    throw new Error(
      "Manifested segment block reference is malformed",
    );
  }
  return candidate;
}

function parseBlock(value: unknown): ManifestedBlockPage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray(
      (value as { documents?: unknown }).documents,
    )
  ) {
    throw new Error("Manifested segment block is malformed");
  }
  const documents = (
    value as { documents: JsonDocument[] }
  ).documents.map((document) => {
    validateDocument(document);
    return document;
  });
  const sorted = [...documents].sort(compareDocuments);
  if (
    sorted.some(
      (document, index) =>
        document.id !== documents[index]?.id,
    )
  ) {
    throw new Error(
      "Manifested segment block is not sorted by ID",
    );
  }
  return { version: 1, documents };
}

function validateDocument(
  document: JsonDocument,
): void {
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    !Object.hasOwn(document, "id") ||
    typeof document.id !== "string" ||
    document.id.length < 1 ||
    document.id.length > 1_024
  ) {
    throw new Error(
      "Manifested segment document is invalid",
    );
  }
  encodeCanonicalJson(document);
}

function snapshot(document: JsonDocument): JsonDocument {
  return decodeJson<JsonDocument>(
    encodeCanonicalJson(document),
  );
}

function compareDocuments(
  left: JsonDocument,
  right: JsonDocument,
): number {
  return left.id < right.id
    ? -1
    : left.id > right.id
      ? 1
      : 0;
}

function validateFields(
  fields: IndexedSegmentField[],
): IndexedSegmentField[] {
  if (fields.length > MAX_FIELDS) {
    throw new Error(
      `Manifested segment supports at most ${MAX_FIELDS} fields`,
    );
  }
  const names = new Set<string>();
  return [...fields]
    .sort((left, right) =>
      left.field < right.field
        ? -1
        : left.field > right.field
          ? 1
          : 0,
    )
    .map((field) => {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(field.field) ||
        (field.mode !== "equality" &&
          field.mode !== "range") ||
        names.has(field.field)
      ) {
        throw new Error(
          "Manifested segment field definition is invalid",
        );
      }
      names.add(field.field);
      return { ...field };
    });
}

async function fieldStats(
  documents: JsonDocument[],
  field: IndexedSegmentField,
): Promise<FieldStats> {
  const values = documents
    .map((document) =>
      ownValue(
        document as Record<string, JsonValue>,
        field.field,
      ),
    )
    .filter(isPrimitive);
  const bloom = new Uint8Array(BLOOM_BYTES);
  await Promise.all(
    values.map(async (value) =>
      bloomAdd(bloom, await scalarHash(value)),
    ),
  );
  if (values.length === 0) {
    return {
      kind: "none",
      bloom: bytesToBase64(bloom),
    };
  }
  const kinds = new Set(values.map(scalarKind));
  if (kinds.size !== 1) {
    return {
      kind: "mixed",
      bloom: bytesToBase64(bloom),
    };
  }
  const kind = scalarKind(values[0]!);
  if (
    field.mode !== "range" ||
    (kind !== "string" && kind !== "number")
  ) {
    return { kind, bloom: bytesToBase64(bloom) };
  }
  const comparable = values as Array<string | number>;
  let min = comparable[0]!;
  let max = comparable[0]!;
  for (const value of comparable.slice(1)) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return {
    kind,
    bloom: bytesToBase64(bloom),
    min,
    max,
  };
}

function blockMayMatch(
  stats: FieldStats,
  predicate: IndexedSegmentPredicate,
  equalityHash: Uint8Array | null,
): boolean {
  if (stats.kind === "none") {
    return false;
  }
  if (predicate.operator === "eq") {
    return bloomMayContain(
      base64ToBytes(stats.bloom),
      equalityHash!,
    );
  }
  if (
    typeof predicate.lower === "number" &&
    typeof predicate.upper === "number"
  ) {
    return (
      stats.kind === "number" &&
      typeof stats.min === "number" &&
      typeof stats.max === "number" &&
      !(
        stats.max < predicate.lower ||
        stats.min > predicate.upper
      )
    );
  }
  if (
    typeof predicate.lower === "string" &&
    typeof predicate.upper === "string"
  ) {
    return (
      stats.kind === "string" &&
      typeof stats.min === "string" &&
      typeof stats.max === "string" &&
      !(
        stats.max < predicate.lower ||
        stats.min > predicate.upper
      )
    );
  }
  return true;
}

function documentMatches(
  document: JsonDocument,
  predicate: IndexedSegmentPredicate,
): boolean {
  const value = ownValue(
    document as Record<string, JsonValue>,
    predicate.field,
  );
  if (!isPrimitive(value)) {
    return false;
  }
  if (predicate.operator === "eq") {
    return value === predicate.value;
  }
  return (
    typeof value === typeof predicate.lower &&
    (typeof value === "string" || typeof value === "number") &&
    value >= predicate.lower &&
    value <= predicate.upper
  );
}

function isPrimitive(
  value: JsonValue | undefined,
): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function scalarKind(value: JsonPrimitive): ScalarKind {
  return value === null ? "null" : typeof value as ScalarKind;
}

async function scalarHash(
  value: JsonPrimitive,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${scalarKind(value)}:${JSON.stringify(value)}`,
      ),
    ),
  );
}

async function bloomAdd(
  bloom: Uint8Array,
  hash: Uint8Array,
): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    const bit =
      (((hash[index * 2] ?? 0) << 8) |
        (hash[index * 2 + 1] ?? 0)) %
      (BLOOM_BYTES * 8);
    bloom[Math.floor(bit / 8)]! |= 1 << (bit % 8);
  }
}

function bloomMayContain(
  bloom: Uint8Array,
  hash: Uint8Array,
): boolean {
  for (let index = 0; index < 4; index += 1) {
    const bit =
      (((hash[index * 2] ?? 0) << 8) |
        (hash[index * 2 + 1] ?? 0)) %
      (BLOOM_BYTES * 8);
    if (
      (bloom[Math.floor(bit / 8)]! &
        (1 << (bit % 8))) ===
      0
    ) {
      return false;
    }
  }
  return true;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(
    new ArrayBuffer(bytes.byteLength),
  );
  copy.set(bytes);
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", copy),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    {
      length: Math.min(concurrency, values.length),
    },
    async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) {
          return;
        }
        output[index] = await operation(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
