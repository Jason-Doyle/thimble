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
  validateName,
} from "../shared-utils.js";

type MonolithState = {
  revision: number;
  documents: Record<string, JsonDocument>;
};

export class MonolithEngine implements DatabaseEngine {
  readonly name = "monolithic-json";
  private retries = 0;

  constructor(
    private readonly store: ObjectStore,
    private readonly maxRetries = 40,
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    const { state } = await this.load(collection);
    return ownValue(state.documents, id) ?? null;
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const { state } = await this.load(collection);
    return Object.values(state.documents).sort((left, right) =>
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
    const key = this.collectionKey(collection);

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const { object, state } = await this.load(collection);
      const nextDocuments = createDictionary(state.documents);
      for (const document of documents) {
        nextDocuments[document.id] = structuredClone(document);
      }
      const nextState: MonolithState = {
        revision: state.revision + 1,
        documents: nextDocuments,
      };

      try {
        await this.store.put(
          key,
          encodeJson(nextState as unknown as JsonValue),
          object === null
            ? { ifNoneMatch: true }
            : { ifMatch: object.etag },
        );
        return;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.retries += 1;
      }
    }

    throw new Error(
      `Monolithic JSON write exceeded ${this.maxRetries} retries`,
    );
  }

  compact(_collection: string): Promise<void> {
    return Promise.resolve();
  }

  diagnostics(): EngineDiagnostics {
    return { casRetries: this.retries };
  }

  private async load(
    collection: string,
  ): Promise<{ object: StoredObject | null; state: MonolithState }> {
    const object = await this.store.get(this.collectionKey(collection));
    if (object === null) {
      return {
        object,
        state: { revision: 0, documents: createDictionary() },
      };
    }
    return { object, state: decodeJson<MonolithState>(object.bytes) };
  }

  private collectionKey(collection: string): string {
    return `monolith/${validateName(collection, "Collection")}.json`;
  }
}
