import type {
  ObjectStore,
  PutConditions,
  StoredObject,
} from "./core.js";
import {
  DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  type EnvelopeEncodeOptions,
} from "./envelope.js";

export class EnvelopeObjectStore implements ObjectStore {
  private readonly maximumDecodedBytes: number;

  constructor(
    private readonly delegate: ObjectStore,
    private readonly envelope: EnvelopeEncodeOptions & {
      objectKeyPrefix?: string;
      decryptionKeys?: ReadonlyMap<string, CryptoKey>;
    },
  ) {
    this.maximumDecodedBytes =
      envelope.maximumDecodedBytes ??
      DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES;
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.delegate.get(key);
    if (object === null) {
      return null;
    }
    return {
      etag: object.etag,
      bytes: await decodeEnvelope(
        object.bytes,
        this.envelope.key && this.envelope.keyId
          ? (keyId) => {
              if (keyId === this.envelope.keyId) {
                return this.envelope.key!;
              }
              return (
                this.envelope.decryptionKeys?.get(keyId) ?? null
              );
            }
          : undefined,
        this.additionalData(key),
        {
          maximumDecodedBytes: this.maximumDecodedBytes,
        },
      ),
    };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    return this.delegate.put(
      key,
      await encodeEnvelope(bytes, {
        ...this.envelope,
        additionalData: this.additionalData(key),
        maximumDecodedBytes: this.maximumDecodedBytes,
      }),
      conditions,
    );
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.delegate.list(prefix);
  }

  private additionalData(key: string): Uint8Array {
    const prefix = this.envelope.objectKeyPrefix?.replace(/\/+$/, "");
    return new TextEncoder().encode(
      prefix ? `${prefix}/${key}` : key,
    );
  }
}
