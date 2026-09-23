import type {
  DatabaseEngine,
  EngineDiagnostics,
  JsonDocument,
  JsonValue,
  ObjectStore,
  StoredObject,
} from "../core.js";
import {
  createDictionary,
  decodeJson,
  encodeJson,
  isPreconditionFailure,
  ownValue,
  sha256,
  validateName,
} from "../utils.js";

type LogMutation = {
  id: string;
  document: JsonDocument;
};

type LogEntry = {
  sequence: number;
  mutations: LogMutation[];
};

type Snapshot = {
  sequence: number;
  documents: Record<string, JsonDocument>;
};

type CurrentState = {
  snapshotKey: string | null;
  snapshotSequence: number;
  tailHint: number;
};

type LoadedCurrent = {
  object: StoredObject;
  state: CurrentState;
};

export class LogSnapshotEngine implements DatabaseEngine {
  readonly name = "append-log-snapshot";
  private appendRetries = 0;
  private hintConflicts = 0;
  private compactionRetries = 0;
  private compactions = 0;
  private garbageCollected = 0;

  constructor(
    private readonly store: ObjectStore,
    private readonly maxRetries = 80,
    private readonly allowQuiescentGarbageCollection = false,
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    const snapshot = await this.materialize(collection);
    return ownValue(snapshot.documents, id) ?? null;
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const snapshot = await this.materialize(collection);
    return Object.values(snapshot.documents).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  put(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void> {
    return this.putMany(collection, [{ ...document, id }]);
  }

  async putMany(
    collection: string,
    documents: JsonDocument[],
  ): Promise<void> {
    const normalized = validateName(collection, "Collection");
    const current = await this.loadCurrent(normalized);
    let sequence = Math.max(
      current.state.snapshotSequence + 1,
      current.state.tailHint,
    );

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const entry: LogEntry = {
        sequence,
        mutations: documents.map((document) => ({
          id: document.id,
          document: structuredClone(document),
        })),
      };

      try {
        await this.store.put(
          this.logKey(normalized, sequence),
          encodeJson(entry as unknown as JsonValue),
          { ifNoneMatch: true },
        );
        await this.advanceTailHint(normalized, sequence + 1);
        return;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.appendRetries += 1;
        sequence += 1;
      }
    }

    throw new Error(
      `Append-log write exceeded ${this.maxRetries} retries`,
    );
  }

  async compact(collection: string): Promise<void> {
    const normalized = validateName(collection, "Collection");

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const current = await this.loadCurrent(normalized);
      const materialized = await this.materializeFrom(
        normalized,
        current.state,
      );

      if (materialized.sequence <= current.state.snapshotSequence) {
        return;
      }

      const snapshot: Snapshot = {
        sequence: materialized.sequence,
        documents: materialized.documents,
      };
      const snapshotBytes = encodeJson(snapshot as unknown as JsonValue);
      const snapshotKey = `${this.collectionPrefix(normalized)}/snapshots/${materialized.sequence.toString().padStart(12, "0")}-${sha256(snapshotBytes)}.json`;

      try {
        await this.store.put(snapshotKey, snapshotBytes, {
          ifNoneMatch: true,
        });
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
      }

      const nextCurrent: CurrentState = {
        snapshotKey,
        snapshotSequence: materialized.sequence,
        tailHint: Math.max(
          current.state.tailHint,
          materialized.sequence + 1,
        ),
      };

      try {
        await this.store.put(
          this.currentKey(normalized),
          encodeJson(nextCurrent as unknown as JsonValue),
          { ifMatch: current.object.etag },
        );
        this.compactions += 1;
        if (this.allowQuiescentGarbageCollection) {
          await this.garbageCollect(
            normalized,
            snapshotKey,
            materialized.sequence,
          );
        }
        return;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.compactionRetries += 1;
      }
    }

    throw new Error(
      `Append-log compaction exceeded ${this.maxRetries} retries`,
    );
  }

  diagnostics(): EngineDiagnostics {
    return {
      appendRetries: this.appendRetries,
      hintConflicts: this.hintConflicts,
      compactionRetries: this.compactionRetries,
      compactions: this.compactions,
      garbageCollected: this.garbageCollected,
    };
  }

  private async materialize(collection: string): Promise<Snapshot> {
    const normalized = validateName(collection, "Collection");
    const current = await this.loadCurrent(normalized);
    return this.materializeFrom(normalized, current.state);
  }

  private async materializeFrom(
    collection: string,
    current: CurrentState,
  ): Promise<Snapshot> {
    let snapshot: Snapshot = {
      sequence: current.snapshotSequence,
      documents: createDictionary(),
    };

    if (current.snapshotKey !== null) {
      const snapshotObject = await this.store.get(current.snapshotKey);
      if (snapshotObject === null) {
        throw new Error(
          `Snapshot ${current.snapshotKey} referenced by current.json is missing`,
        );
      }
      snapshot = decodeJson<Snapshot>(snapshotObject.bytes);
    }

    const documents = createDictionary(snapshot.documents);
    const firstLogSequence = snapshot.sequence + 1;
    const trustedTail = Math.max(firstLogSequence, current.tailHint);
    const trustedSequences = Array.from(
      { length: trustedTail - firstLogSequence },
      (_, index) => firstLogSequence + index,
    );
    const trustedEntries = await Promise.all(
      trustedSequences.map(async (sequence) => {
        const object = await this.store.get(
          this.logKey(collection, sequence),
        );
        if (object === null) {
          throw new Error(
            `Log ${sequence} is missing below trusted tail ${trustedTail}`,
          );
        }
        return decodeJson<LogEntry>(object.bytes);
      }),
    );
    for (const entry of trustedEntries) {
      for (const mutation of entry.mutations) {
        documents[mutation.id] = mutation.document;
      }
    }

    let sequence = trustedTail;
    for (;;) {
      const object = await this.store.get(
        this.logKey(collection, sequence),
      );
      if (object === null) {
        break;
      }
      const entry = decodeJson<LogEntry>(object.bytes);
      for (const mutation of entry.mutations) {
        documents[mutation.id] = mutation.document;
      }
      sequence += 1;
    }

    return {
      sequence: sequence - 1,
      documents,
    };
  }

  private async loadCurrent(collection: string): Promise<LoadedCurrent> {
    const key = this.currentKey(collection);
    const existing = await this.store.get(key);
    if (existing !== null) {
      return {
        object: existing,
        state: decodeJson<CurrentState>(existing.bytes),
      };
    }

    const initial: CurrentState = {
      snapshotKey: null,
      snapshotSequence: -1,
      tailHint: 0,
    };
    try {
      await this.store.put(
        key,
        encodeJson(initial as unknown as JsonValue),
        { ifNoneMatch: true },
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
    }

    const created = await this.store.get(key);
    if (created === null) {
      throw new Error(`Failed to initialize ${key}`);
    }
    return {
      object: created,
      state: decodeJson<CurrentState>(created.bytes),
    };
  }

  private async advanceTailHint(
    collection: string,
    nextSequence: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.loadCurrent(collection);
      if (current.state.tailHint >= nextSequence) {
        return;
      }
      const next: CurrentState = {
        ...current.state,
        tailHint: nextSequence,
      };
      try {
        await this.store.put(
          this.currentKey(collection),
          encodeJson(next as unknown as JsonValue),
          { ifMatch: current.object.etag },
        );
        return;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.hintConflicts += 1;
      }
    }
  }

  private async garbageCollect(
    collection: string,
    currentSnapshotKey: string,
    snapshotSequence: number,
  ): Promise<void> {
    const logPrefix = `${this.collectionPrefix(collection)}/log/`;
    const snapshotPrefix = `${this.collectionPrefix(collection)}/snapshots/`;
    const [logKeys, snapshotKeys] = await Promise.all([
      this.store.list(logPrefix),
      this.store.list(snapshotPrefix),
    ]);
    const staleLogs = logKeys.filter((key) => {
      const fileName = key.slice(logPrefix.length).replace(/\.json$/, "");
      const sequence = Number(fileName);
      return Number.isInteger(sequence) && sequence <= snapshotSequence;
    });
    const staleSnapshots = snapshotKeys.filter(
      (key) => key !== currentSnapshotKey,
    );
    const staleKeys = [...staleLogs, ...staleSnapshots];
    await Promise.all(staleKeys.map((key) => this.store.delete(key)));
    this.garbageCollected += staleKeys.length;
  }

  private collectionPrefix(collection: string): string {
    return `log-snapshot/${collection}`;
  }

  private currentKey(collection: string): string {
    return `${this.collectionPrefix(collection)}/current.json`;
  }

  private logKey(collection: string, sequence: number): string {
    return `${this.collectionPrefix(collection)}/log/${sequence
      .toString()
      .padStart(12, "0")}.json`;
  }
}
