import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "./core.js";

export class PrefixObjectStore implements ObjectStore {
  constructor(
    private readonly delegate: ObjectStore,
    private readonly prefix: string,
  ) {}

  get(key: string): Promise<StoredObject | null> {
    return this.delegate.get(this.key(key));
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    return this.delegate.put(this.key(key), bytes, conditions);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(this.key(key));
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.prefix.replace(/\/+$/, "");
    if (!base) {
      return this.delegate.list(prefix);
    }
    const basePrefix = `${base}/`;
    const keys = await this.delegate.list(
      prefix ? this.key(prefix) : basePrefix,
    );
    return keys
      .filter((key) => key.startsWith(basePrefix))
      .map((key) => key.slice(basePrefix.length));
  }

  private key(key: string): string {
    const base = this.prefix.replace(/^\/+|\/+$/g, "");
    const suffix = key.replace(/^\/+/, "");
    if (!base) {
      return suffix;
    }
    return suffix ? `${base}/${suffix}` : base;
  }
}
