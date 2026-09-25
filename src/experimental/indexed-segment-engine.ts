import type {
  DatabaseEngine,
  EngineDiagnostics,
  JsonDocument,
} from "../core.js";
import { validateName } from "../shared-utils.js";
import {
  buildIndexedSegment,
  IndexedSegmentReader,
  MemoryIndexedSegmentSource,
  type IndexedSegmentBuildOptions,
  type IndexedSegmentField,
  type IndexedSegmentPredicate,
  type IndexedSegmentQueryResult,
} from "./indexed-segment.js";

export type IndexedSegmentEngineOptions = {
  targetBlockBytes?: number;
  compression?: "gzip" | "none";
  recordEncoding?: "json" | "binary";
  collectionFields?: Record<string, IndexedSegmentField[]>;
};

type CollectionState = {
  documents: Map<string, JsonDocument>;
  segment: Uint8Array;
  reader: IndexedSegmentReader;
};

export class ExperimentalIndexedSegmentEngine
implements DatabaseEngine {
  readonly name = "experimental-indexed-segment";
  private readonly collections = new Map<
    string,
    CollectionState
  >();
  private readonly queues = new Map<string, Promise<void>>();
  private rebuilds = 0;
  private encodedBytes = 0;

  constructor(
    private readonly options: IndexedSegmentEngineOptions = {},
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    const normalized = validateName(collection, "Collection");
    await this.waitForWrites(normalized);
    return (
      (await this.collections.get(normalized)?.reader.get(id)) ??
      null
    );
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const normalized = validateName(collection, "Collection");
    await this.waitForWrites(normalized);
    return (
      (await this.collections.get(normalized)?.reader.scan()) ??
      []
    );
  }

  put(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void> {
    if (document.id !== id) {
      return Promise.reject(
        new Error("Document id does not match the storage key"),
      );
    }
    return this.mutate(collection, (documents) => {
      documents.set(id, structuredClone(document));
    });
  }

  putMany(
    collection: string,
    documents: JsonDocument[],
  ): Promise<void> {
    return this.mutate(collection, (current) => {
      for (const document of documents) {
        current.set(
          document.id,
          structuredClone(document),
        );
      }
    });
  }

  async compact(collection: string): Promise<void> {
    await this.mutate(collection, () => {});
  }

  async query(
    collection: string,
    predicate: IndexedSegmentPredicate,
    limit?: number,
  ): Promise<IndexedSegmentQueryResult> {
    const normalized = validateName(collection, "Collection");
    await this.waitForWrites(normalized);
    const reader = this.collections.get(normalized)?.reader;
    if (!reader) {
      return {
        documents: [],
        plan: "scan",
        blocksConsidered: 0,
        blocksRead: 0,
        blocksSkipped: 0,
      };
    }
    return limit === undefined
      ? reader.query(predicate)
      : reader.query(predicate, limit);
  }

  diagnostics(): EngineDiagnostics {
    return {
      collections: this.collections.size,
      rebuilds: this.rebuilds,
      encodedBytes: this.encodedBytes,
      currentBytes: [...this.collections.values()].reduce(
        (total, state) => total + state.segment.byteLength,
        0,
      ),
    };
  }

  private mutate(
    collection: string,
    update: (documents: Map<string, JsonDocument>) => void,
  ): Promise<void> {
    const normalized = validateName(collection, "Collection");
    const previous =
      this.queues.get(normalized) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const existing = this.collections.get(normalized);
      const documents = new Map(
        existing?.documents ?? [],
      );
      update(documents);
      const segment = await buildIndexedSegment(
        [...documents.values()],
        this.buildOptions(normalized),
      );
      const reader = await IndexedSegmentReader.open(
        new MemoryIndexedSegmentSource(segment),
      );
      this.collections.set(normalized, {
        documents,
        segment,
        reader,
      });
      this.rebuilds += 1;
      this.encodedBytes += segment.byteLength;
    });
    this.queues.set(
      normalized,
      operation.then(
        () => {},
        () => {},
      ),
    );
    return operation;
  }

  private async waitForWrites(collection: string): Promise<void> {
    await (this.queues.get(collection) ?? Promise.resolve());
  }

  private buildOptions(
    collection: string,
  ): IndexedSegmentBuildOptions {
    const collectionFields = this.options.collectionFields;
    return {
      ...(this.options.targetBlockBytes !== undefined
        ? {
            targetBlockBytes:
              this.options.targetBlockBytes,
          }
        : {}),
      ...(this.options.compression !== undefined
        ? { compression: this.options.compression }
        : {}),
      ...(this.options.recordEncoding !== undefined
        ? {
            recordEncoding:
              this.options.recordEncoding,
          }
        : {}),
      fields:
        collectionFields &&
        Object.hasOwn(collectionFields, collection)
          ? collectionFields[collection] ?? []
          : [],
    };
  }
}
