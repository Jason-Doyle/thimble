const MAGIC = new Uint8Array([0x54, 0x44, 0x42, 0x31]);
const FIXED_HEADER_BYTES = 8;
const FLAG_GZIP = 1;
const FLAG_ENCRYPTED = 2;
const GCM_IV_BYTES = 12;

export type EnvelopeMetadata = {
  compressed: boolean;
  encrypted: boolean;
  keyId: string | null;
  headerBytes: number;
};

export type EnvelopeEncodeOptions = {
  key?: CryptoKey;
  keyId?: string;
  compression?: "gzip" | "none";
  minimumCompressionSavings?: number;
  additionalData?: Uint8Array;
};

export type EnvelopeKeyResolver = (
  keyId: string,
) => Promise<CryptoKey | null> | CryptoKey | null;

export type EnvelopeDecodeOptions = {
  maximumDecodedBytes?: number;
};

export async function encodeEnvelope(
  plaintext: Uint8Array,
  options: EnvelopeEncodeOptions = {},
): Promise<Uint8Array> {
  const compression = options.compression ?? "gzip";
  const minimumSavings = options.minimumCompressionSavings ?? 8;
  let payload = plaintext;
  let compressed = false;

  if (compression === "gzip" && plaintext.byteLength > 0) {
    const candidate = await gzip(plaintext);
    if (
      candidate.byteLength + minimumSavings <
      plaintext.byteLength
    ) {
      payload = candidate;
      compressed = true;
    }
  }

  const encrypted = options.key !== undefined;
  const keyId = options.keyId ?? "";
  if (encrypted && keyId.length === 0) {
    throw new Error("Encrypted envelopes require a key id");
  }
  if (!encrypted && keyId.length > 0) {
    throw new Error("Unencrypted envelopes cannot include a key id");
  }

  const keyIdBytes = new TextEncoder().encode(keyId);
  if (keyIdBytes.byteLength > 65_535) {
    throw new Error("Envelope key id is too long");
  }
  const iv = encrypted
    ? crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES))
    : new Uint8Array();
  const flags =
    (compressed ? FLAG_GZIP : 0) |
    (encrypted ? FLAG_ENCRYPTED : 0);
  const header = createHeader(flags, keyIdBytes, iv);
  const authenticatedData = combineAuthenticatedData(
    header,
    options.additionalData,
  );

  if (encrypted) {
    payload = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toBufferView(iv),
          additionalData: toBufferView(authenticatedData),
          tagLength: 128,
        },
        options.key!,
        toBufferView(payload),
      ),
    );
  }

  return concatenate(header, payload);
}

export async function decodeEnvelope(
  envelope: Uint8Array,
  resolveKey?: EnvelopeKeyResolver,
  additionalData?: Uint8Array,
  options: EnvelopeDecodeOptions = {},
): Promise<Uint8Array> {
  const maximumDecodedBytes = options.maximumDecodedBytes;
  if (
    maximumDecodedBytes !== undefined &&
    (!Number.isSafeInteger(maximumDecodedBytes) ||
      maximumDecodedBytes < 0)
  ) {
    throw new Error(
      "Envelope maximum decoded bytes must be a non-negative safe integer",
    );
  }
  const metadata = inspectEnvelope(envelope);
  const header = envelope.slice(0, metadata.headerBytes);
  let payload = envelope.slice(metadata.headerBytes);

  if (metadata.encrypted) {
    if (!metadata.keyId || !resolveKey) {
      throw new Error(
        `No decryption key resolver is available for ${metadata.keyId ?? "unknown key"}`,
      );
    }
    const key = await resolveKey(metadata.keyId);
    if (!key) {
      throw new Error(`No decryption key was granted for ${metadata.keyId}`);
    }
    const ivLength = envelope[7] ?? 0;
    const keyIdLength = readUint16(envelope, 5);
    const ivStart = FIXED_HEADER_BYTES + keyIdLength;
    const iv = envelope.slice(ivStart, ivStart + ivLength);
    payload = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toBufferView(iv),
          additionalData: toBufferView(
            combineAuthenticatedData(header, additionalData),
          ),
          tagLength: 128,
        },
        key,
        toBufferView(payload),
      ),
    );
  }

  if (metadata.compressed) {
    return gunzip(payload, maximumDecodedBytes);
  }
  requireDecodedLimit(payload.byteLength, maximumDecodedBytes);
  return payload;
}

export function inspectEnvelope(
  envelope: Uint8Array,
): EnvelopeMetadata {
  if (envelope.byteLength < FIXED_HEADER_BYTES) {
    throw new Error("Envelope is shorter than its fixed header");
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (envelope[index] !== MAGIC[index]) {
      throw new Error("Object is not a ThimbleDB envelope");
    }
  }

  const flags = envelope[4] ?? 0;
  if ((flags & ~(FLAG_GZIP | FLAG_ENCRYPTED)) !== 0) {
    throw new Error("Envelope contains unsupported flags");
  }
  const keyIdLength = readUint16(envelope, 5);
  const ivLength = envelope[7] ?? 0;
  const headerBytes =
    FIXED_HEADER_BYTES + keyIdLength + ivLength;
  if (headerBytes > envelope.byteLength) {
    throw new Error("Envelope header exceeds object length");
  }

  const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
  if (encrypted && ivLength !== GCM_IV_BYTES) {
    throw new Error("Encrypted envelope has an invalid AES-GCM IV");
  }
  if (!encrypted && (keyIdLength !== 0 || ivLength !== 0)) {
    throw new Error("Unencrypted envelope contains key metadata");
  }

  const keyId =
    keyIdLength === 0
      ? null
      : new TextDecoder().decode(
          envelope.slice(
            FIXED_HEADER_BYTES,
            FIXED_HEADER_BYTES + keyIdLength,
          ),
        );
  return {
    compressed: (flags & FLAG_GZIP) !== 0,
    encrypted,
    keyId,
    headerBytes,
  };
}

export async function importAesGcmKey(
  rawKey: Uint8Array,
  usages: KeyUsage[],
  extractable = false,
): Promise<CryptoKey> {
  if (rawKey.byteLength !== 32) {
    throw new Error("AES-256-GCM keys must be exactly 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    toBufferView(rawKey),
    { name: "AES-GCM" },
    extractable,
    usages,
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return transform(bytes, new CompressionStream("gzip"));
}

async function gunzip(
  bytes: Uint8Array,
  maximumOutputBytes?: number,
): Promise<Uint8Array> {
  return transform(
    bytes,
    new DecompressionStream("gzip"),
    maximumOutputBytes,
  );
}

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maximumOutputBytes?: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const write = (async () => {
    await writer.write(toBufferView(bytes));
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = new Uint8Array(result.value);
      total += chunk.byteLength;
      requireDecodedLimit(total, maximumOutputBytes);
      chunks.push(chunk);
    }
    await write;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await writer.abort(error).catch(() => {});
    await write.catch(() => {});
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function requireDecodedLimit(
  bytes: number,
  maximum: number | undefined,
): void {
  if (maximum !== undefined && bytes > maximum) {
    throw new Error(
      `Envelope decoded payload exceeds ${maximum} bytes`,
    );
  }
}

function toBufferView(
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function combineAuthenticatedData(
  header: Uint8Array,
  additionalData: Uint8Array | undefined,
): Uint8Array {
  if (!additionalData || additionalData.byteLength === 0) {
    return header;
  }
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(
    0,
    additionalData.byteLength,
    false,
  );
  return concatenate(concatenate(header, length), additionalData);
}

function createHeader(
  flags: number,
  keyId: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(
    FIXED_HEADER_BYTES + keyId.byteLength + iv.byteLength,
  );
  header.set(MAGIC, 0);
  header[4] = flags;
  writeUint16(header, 5, keyId.byteLength);
  header[7] = iv.byteLength;
  header.set(keyId, FIXED_HEADER_BYTES);
  header.set(iv, FIXED_HEADER_BYTES + keyId.byteLength);
  return header;
}

function concatenate(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function writeUint16(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}
