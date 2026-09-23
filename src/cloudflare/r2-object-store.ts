import {
  PreconditionFailedError,
  type ObjectStore,
  type PutConditions,
  type StoredObject,
} from "../core.js";

export type R2BucketBinding = {
  get(
    key: string,
  ): Promise<
    | {
        etag: string;
        arrayBuffer(): Promise<ArrayBuffer>;
      }
    | null
  >;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      onlyIf?: {
        etagMatches?: string;
        etagDoesNotMatch?: string;
      };
    },
  ): Promise<{ etag: string } | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
};

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2BucketBinding) {}

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      etag: quoteEtag(object.etag),
    };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions: PutConditions = {},
  ): Promise<{ etag: string }> {
    const onlyIf: {
      etagMatches?: string;
      etagDoesNotMatch?: string;
    } = {};
    if (conditions.ifMatch !== undefined) {
      onlyIf.etagMatches = unquoteEtag(conditions.ifMatch);
    }
    if (conditions.ifNoneMatch) {
      onlyIf.etagDoesNotMatch = "*";
    }

    const value = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    value.set(bytes);
    const result = await this.bucket.put(key, value, {
      onlyIf,
    });
    if (!result) {
      throw new PreconditionFailedError(
        `Conditional R2 write failed for ${key}`,
      );
    }
    return { etag: quoteEtag(result.etag) };
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const options: {
        prefix: string;
        cursor?: string;
        limit: number;
      } = {
        prefix,
        limit: 1_000,
      };
      if (cursor) {
        options.cursor = cursor;
      }
      const page = await this.bucket.list(options);
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys.sort();
  }
}

function unquoteEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

function quoteEtag(etag: string): string {
  const raw = unquoteEtag(etag);
  return `"${raw}"`;
}
