import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../core.js";
import {
  errorName,
  httpStatus,
  mapPreconditionError,
  normalizeObjectKey,
} from "../store-utils.js";

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
      ? normalizeObjectKey(prefix)
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
