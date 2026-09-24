import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";
import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../core.js";
import {
  httpStatus,
  mapPreconditionError,
  normalizeObjectKey,
} from "../store-utils.js";

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
      ? normalizeObjectKey(prefix)
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

async function streamToBytes(
  stream: NodeJS.ReadableStream,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
