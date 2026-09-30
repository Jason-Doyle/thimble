import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../../src/core.js";

export class DuplicateIndexReadStore
implements ObjectStore {
  constructor(private readonly delegate: ObjectStore) {}

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.delegate.get(key);
    if (key.includes("/indexes/")) {
      await this.delegate.get(key);
    }
    return object;
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ) {
    return this.delegate.put(
      key,
      bytes,
      conditions,
    );
  }

  delete(key: string) {
    return this.delegate.delete(key);
  }

  list(prefix: string) {
    return this.delegate.list(prefix);
  }
}
