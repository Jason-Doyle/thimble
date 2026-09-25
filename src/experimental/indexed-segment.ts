import type {
  JsonDocument,
  JsonPrimitive,
  JsonValue,
} from "../core.js";
import {
  decodeEnvelope,
  encodeEnvelope,
  type EnvelopeEncodeOptions,
  type EnvelopeKeyResolver,
} from "../envelope.js";
import {
  decodeJson,
  ownValue,
} from "../shared-utils.js";

const TRAILER_MAGIC = new Uint8Array([
  0x54,
  0x49,
  0x53,
  0x31,
]);
const FOOTER_MAGIC = new Uint8Array([
  0x54,
  0x49,
  0x53,
  0x46,
]);
const FORMAT_VERSION = 1;
const TRAILER_BYTES = 40;
const FINGERPRINT_BYTES = 8;
const FINGERPRINT_CHECK_BYTES = 16;
const INTEGRITY_HASH_BYTES = 16;
const BLOOM_BYTES = 32;
const FOOTER_FLAG_BINARY_RECORDS = 1;
const FOOTER_FLAG_KEYED_FINGERPRINTS = 2;
const DEFAULT_BLOCK_BYTES = 64 * 1024;
const MAX_BLOCK_BYTES = 4 * 1024 * 1024;
const MAX_FOOTER_BYTES = 16 * 1024 * 1024;
const MAX_FIELDS = 8;
const MAX_DOCUMENTS = 1_000_000;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_DECODED_BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_ID_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;
const MAX_STORED_BLOCK_BYTES =
  MAX_DECODED_BLOCK_BYTES + MAX_ENVELOPE_OVERHEAD_BYTES;
const MAX_STORED_ID_INDEX_BYTES =
  MAX_DECODED_ID_INDEX_BYTES +
  MAX_ENVELOPE_OVERHEAD_BYTES;
const MAX_STORED_FOOTER_BYTES =
  MAX_FOOTER_BYTES + MAX_ENVELOPE_OVERHEAD_BYTES;
const MAX_RANGE_RESPONSE_BYTES = Math.max(
  MAX_STORED_BLOCK_BYTES,
  MAX_STORED_ID_INDEX_BYTES,
  MAX_STORED_FOOTER_BYTES,
);
const MAX_COALESCED_RANGE_BYTES = 8 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export type IndexedSegmentField = {
  field: string;
  mode: "equality" | "range";
};

export type IndexedSegmentBuildOptions = {
  targetBlockBytes?: number;
  compression?: "gzip" | "none";
  recordEncoding?: "json" | "binary";
  fields?: IndexedSegmentField[];
  security?: IndexedSegmentWriteSecurity;
};

export type IndexedSegmentWriteSecurity = {
  key: CryptoKey;
  keyId: string;
  fingerprintKey: CryptoKey;
  context?: string;
};

export type IndexedSegmentReadSecurity = {
  resolveKey: EnvelopeKeyResolver;
  fingerprintKey: CryptoKey;
  context?: string;
};

export type IndexedSegmentPredicate =
  | {
      field: string;
      operator: "eq";
      value: JsonPrimitive;
    }
  | {
      field: string;
      operator: "between";
      lower: string | number;
      upper: string | number;
    };

export type IndexedSegmentQueryResult = {
  documents: JsonDocument[];
  plan: "block-filter" | "scan";
  blocksConsidered: number;
  blocksRead: number;
  blocksSkipped: number;
};

export type IndexedSegmentDiagnostics = {
  documents: number;
  blocks: number;
  footerBytes: number;
  dataBytes: number;
  indexBytes: number;
  decodedDataBytes: number;
  indexedFields: number;
};

export interface IndexedSegmentSource {
  readonly byteLength: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class MemoryIndexedSegmentSource
implements IndexedSegmentSource {
  readonly byteLength: number;
  reads = 0;
  bytesRead = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.byteLength = bytes.byteLength;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(offset, length, this.byteLength, "Segment read");
    this.reads += 1;
    this.bytesRead += length;
    return Promise.resolve(
      this.bytes.slice(offset, offset + length),
    );
  }

  resetMetrics(): void {
    this.reads = 0;
    this.bytesRead = 0;
  }
}

export class BlobIndexedSegmentSource
implements IndexedSegmentSource {
  readonly byteLength: number;
  reads = 0;
  bytesRead = 0;

  constructor(private readonly blob: Blob) {
    this.byteLength = blob.size;
  }

  async read(
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    assertRange(offset, length, this.byteLength, "Blob read");
    this.reads += 1;
    this.bytesRead += length;
    return new Uint8Array(
      await this.blob
        .slice(offset, offset + length)
        .arrayBuffer(),
    );
  }
}

export type HttpIndexedSegmentSourceOptions = {
  fetch?: typeof fetch;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  directoryPrefetchBytes?: number;
};

export class HttpIndexedSegmentSource
implements IndexedSegmentSource {
  reads = 0;
  bytesRead = 0;

  private constructor(
    private readonly url: string,
    readonly byteLength: number,
    private readonly fetcher: typeof fetch,
    private readonly headers: Headers,
    private readonly credentials: RequestCredentials,
    private readonly prefetchedOffset: number,
    private readonly prefetchedBytes: Uint8Array,
  ) {}

  static async open(
    url: string,
    options: HttpIndexedSegmentSourceOptions = {},
  ): Promise<HttpIndexedSegmentSource> {
    const fetcher = options.fetch ?? fetch;
    const headers = new Headers(options.headers);
    const prefetchBytes =
      options.directoryPrefetchBytes ?? 64 * 1024;
    if (
      !Number.isInteger(prefetchBytes) ||
      prefetchBytes < TRAILER_BYTES ||
      prefetchBytes > 1024 * 1024
    ) {
      throw new Error(
        "Indexed segment directory prefetch must be 40-1048576 bytes",
      );
    }
    headers.set("range", `bytes=-${prefetchBytes}`);
    const response = await fetcher.call(globalThis, url, {
      method: "GET",
      headers,
      credentials: options.credentials ?? "include",
    });
    if (response.status !== 206) {
      throw new Error(
        `Indexed segment suffix request returned ${response.status}; expected 206`,
      );
    }
    const contentRange = parseContentRange(
      response.headers.get("content-range"),
    );
    const bytes = await readExactResponse(
      response,
      contentRange.end - contentRange.start + 1,
    );
    if (
      contentRange.total < TRAILER_BYTES ||
      contentRange.end - contentRange.start + 1 !==
        bytes.byteLength
    ) {
      throw new Error(
        "Indexed segment suffix response length is invalid",
      );
    }
    const source = new HttpIndexedSegmentSource(
      url,
      contentRange.total,
      fetcher,
      headers,
      options.credentials ?? "include",
      contentRange.start,
      bytes,
    );
    source.reads = 1;
    source.bytesRead = bytes.byteLength;
    return source;
  }

  async read(
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    assertRange(offset, length, this.byteLength, "HTTP range");
    if (length === 0) {
      return new Uint8Array();
    }
    if (length > MAX_RANGE_RESPONSE_BYTES) {
      throw new Error(
        "Indexed segment HTTP range exceeds the format limit",
      );
    }
    if (
      offset >= this.prefetchedOffset &&
      offset + length <=
        this.prefetchedOffset + this.prefetchedBytes.byteLength
    ) {
      const start = offset - this.prefetchedOffset;
      return this.prefetchedBytes.slice(start, start + length);
    }
    const headers = new Headers(this.headers);
    headers.set(
      "range",
      `bytes=${offset}-${offset + length - 1}`,
    );
    const response = await this.fetcher.call(
      globalThis,
      this.url,
      {
      method: "GET",
      headers,
      credentials: this.credentials,
      },
    );
    if (response.status !== 206) {
      throw new Error(
        `Indexed segment range request returned ${response.status}; expected 206`,
      );
    }
    const contentRange = parseContentRange(
      response.headers.get("content-range"),
    );
    if (
      contentRange.start !== offset ||
      contentRange.end !== offset + length - 1 ||
      contentRange.total !== this.byteLength
    ) {
      throw new Error(
        "Indexed segment Content-Range does not match the request",
      );
    }
    const bytes = await readExactResponse(response, length);
    this.reads += 1;
    this.bytesRead += bytes.byteLength;
    return bytes;
  }
}

type ScalarKind =
  | "none"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "mixed";

type FieldStats = {
  kind: ScalarKind;
  bloom: Uint8Array;
  min?: JsonPrimitive;
  max?: JsonPrimitive;
};

type BlockDescriptor = {
  offset: number;
  storedLength: number;
  decodedLength: number;
  recordCount: number;
  hash: Uint8Array;
  stats: FieldStats[];
};

type IdIndexEntry = {
  hash: Uint8Array;
  block: number;
  record: number;
};

type IdIndexShardDescriptor = {
  shard: number;
  offset: number;
  storedLength: number;
  decodedLength: number;
  entries: number;
  hash: Uint8Array;
};

type ParsedFooter = {
  recordEncoding: "json" | "binary";
  keyedFingerprints: boolean;
  fingerprintCheck: Uint8Array;
  documentCount: number;
  fields: IndexedSegmentField[];
  blocks: BlockDescriptor[];
  idIndexShards: Map<number, IdIndexShardDescriptor>;
  footerBytes: number;
  dataBytes: number;
  indexBytes: number;
  decodedDataBytes: number;
};

type PreparedRecord = {
  document: JsonDocument;
  bytes: Uint8Array;
  hash: Uint8Array;
};

type PreparedBlock = {
  bytes: Uint8Array;
  decodedLength: number;
  hash: Uint8Array;
  records: Array<{
    hash: Uint8Array;
    offset: number;
    length: number;
  }>;
  stats: FieldStats[];
};

type ParsedBlock = {
  bytes: Uint8Array;
  records: Array<{
    offset: number;
    length: number;
  }>;
};

export async function buildIndexedSegment(
  input: JsonDocument[],
  options: IndexedSegmentBuildOptions = {},
): Promise<Uint8Array> {
  if (input.length > MAX_DOCUMENTS) {
    throw new Error(
      `Indexed segment supports at most ${MAX_DOCUMENTS} documents`,
    );
  }
  const targetBlockBytes =
    options.targetBlockBytes ?? DEFAULT_BLOCK_BYTES;
  if (
    !Number.isInteger(targetBlockBytes) ||
    targetBlockBytes < 1_024 ||
    targetBlockBytes > MAX_BLOCK_BYTES
  ) {
    throw new Error(
      `Indexed segment block size must be 1024-${MAX_BLOCK_BYTES} bytes`,
    );
  }
  const fields = validateFields(options.fields ?? []);
  const recordEncoding = options.recordEncoding ?? "json";
  validateWriteSecurity(options.security);
  const context = options.security?.context ?? "experimental";
  const documents = input
    .map(snapshotDocument)
    .sort((left, right) =>
      compareText(left.id, right.id),
    );
  const ids = new Set<string>();
  for (const document of documents) {
    if (!Object.hasOwn(document, "id")) {
      throw new Error(
        "Indexed segment document requires an own id field",
      );
    }
    validateJsonValue(document);
    validateDocumentId(document.id);
    if (ids.has(document.id)) {
      throw new Error(
        `Indexed segment contains duplicate document id ${document.id}`,
      );
    }
    ids.add(document.id);
  }

  const prepared = await Promise.all(
    documents.map(async (document): Promise<PreparedRecord> => {
      const bytes = encodeRecord(document, recordEncoding);
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new Error(
          `Indexed segment document ${document.id} exceeds ${MAX_DOCUMENT_BYTES} bytes`,
        );
      }
      return {
        document,
        bytes,
        hash: await fingerprint(
          textBytes(document.id),
          options.security?.fingerprintKey,
        ),
      };
    }),
  );
  const groups = groupRecords(prepared, targetBlockBytes);
  const blocks = await Promise.all(
    groups.map((group, index) =>
      prepareBlock(
        group,
        fields,
        options.compression ?? "gzip",
        index,
        context,
        options.security,
      ),
    ),
  );

  const dataParts: Uint8Array[] = [];
  const blockDescriptors: BlockDescriptor[] = [];
  const idIndexEntries: IdIndexEntry[][] = Array.from(
    { length: 256 },
    () => [],
  );
  let dataOffset = 0;
  for (const [blockIndex, block] of blocks.entries()) {
    dataParts.push(block.bytes);
    blockDescriptors.push({
      offset: dataOffset,
      storedLength: block.bytes.byteLength,
      decodedLength: block.decodedLength,
      recordCount: block.records.length,
      hash: block.hash,
      stats: block.stats,
    });
    for (const [recordIndex, record] of block.records.entries()) {
      idIndexEntries[record.hash[0]!]!.push({
        hash: record.hash,
        block: blockIndex,
        record: recordIndex,
      });
    }
    dataOffset += block.bytes.byteLength;
  }

  const idIndexShards: IdIndexShardDescriptor[] = [];
  for (const [shard, entries] of idIndexEntries.entries()) {
    if (entries.length === 0) {
      continue;
    }
    entries.sort((left, right) =>
      compareBytes(left.hash, right.hash),
    );
    const plaintext = encodeIdIndexShard(entries);
    if (
      plaintext.byteLength > MAX_DECODED_ID_INDEX_BYTES
    ) {
      throw new Error(
        "Indexed segment ID index shard exceeds its decoded limit",
      );
    }
    const bytes = await encodeEnvelope(
      plaintext,
      envelopeOptions(
        "gzip",
        idIndexAdditionalData(context, shard),
        options.security,
      ),
    );
    if (bytes.byteLength > MAX_STORED_ID_INDEX_BYTES) {
      throw new Error(
        "Indexed segment stored ID index shard exceeds its limit",
      );
    }
    dataParts.push(bytes);
    idIndexShards.push({
      shard,
      offset: dataOffset,
      storedLength: bytes.byteLength,
      decodedLength: plaintext.byteLength,
      entries: entries.length,
      hash: (await sha256(bytes)).slice(
        0,
        INTEGRITY_HASH_BYTES,
      ),
    });
    dataOffset += bytes.byteLength;
  }

  const footerPlaintext = encodeFooter(
    recordEncoding,
    options.security !== undefined,
    options.security
      ? await fingerprintCheck(
          options.security.fingerprintKey,
          context,
        )
      : new Uint8Array(),
    documents.length,
    fields,
    blockDescriptors,
    idIndexShards,
  );
  if (footerPlaintext.byteLength > MAX_FOOTER_BYTES) {
    throw new Error(
      `Indexed segment footer exceeds ${MAX_FOOTER_BYTES} bytes`,
    );
  }
  const footer = await encodeEnvelope(
    footerPlaintext,
    envelopeOptions(
      "gzip",
      footerAdditionalData(context),
      options.security,
    ),
  );
  if (footer.byteLength > MAX_STORED_FOOTER_BYTES) {
    throw new Error(
      "Indexed segment stored footer exceeds its limit",
    );
  }
  const footerHash = await sha256(footer);
  const trailer = new BinaryWriter();
  trailer.writeBytes(TRAILER_MAGIC);
  trailer.writeUint32(footer.byteLength);
  trailer.writeBytes(footerHash);
  return concatenate([
    ...dataParts,
    footer,
    trailer.finish(),
  ]);
}

export class IndexedSegmentReader {
  private readonly blockCache = new Map<number, ParsedBlock>();
  private readonly idIndexCache = new Map<
    number,
    IdIndexEntry[]
  >();

  private constructor(
    private readonly source: IndexedSegmentSource,
    private readonly footer: ParsedFooter,
    private readonly cacheBlocks: boolean,
    private readonly cacheIndexShards: boolean,
    private readonly security: IndexedSegmentReadSecurity | undefined,
    private readonly context: string,
  ) {}

  static async open(
    source: IndexedSegmentSource,
    options: {
      cacheBlocks?: boolean;
      cacheIndexShards?: boolean;
      security?: IndexedSegmentReadSecurity;
    } = {},
  ): Promise<IndexedSegmentReader> {
    validateReadSecurity(options.security);
    if (source.byteLength < TRAILER_BYTES) {
      throw new Error("Indexed segment is shorter than its trailer");
    }
    const trailer = await source.read(
      source.byteLength - TRAILER_BYTES,
      TRAILER_BYTES,
    );
    assertMagic(trailer.slice(0, 4), TRAILER_MAGIC, "segment");
    const trailerView = dataView(trailer);
    const footerLength = trailerView.getUint32(4, false);
    if (
      footerLength < 16 ||
      footerLength > MAX_STORED_FOOTER_BYTES ||
      footerLength > source.byteLength - TRAILER_BYTES
    ) {
      throw new Error("Indexed segment footer length is invalid");
    }
    const footerOffset =
      source.byteLength - TRAILER_BYTES - footerLength;
    const footerEnvelope = await source.read(
      footerOffset,
      footerLength,
    );
    const expectedHash = trailer.slice(8);
    const actualHash = await sha256(footerEnvelope);
    if (!equalBytes(expectedHash, actualHash)) {
      throw new Error("Indexed segment footer hash mismatch");
    }
    const context =
      options.security?.context ?? "experimental";
    const footerBytes = await decodeEnvelope(
      footerEnvelope,
      options.security?.resolveKey,
      footerAdditionalData(context),
      { maximumDecodedBytes: MAX_FOOTER_BYTES },
    );
    const footer = parseFooter(
      footerBytes,
      footerOffset,
      footerEnvelope.byteLength,
    );
    if (
      footer.keyedFingerprints &&
      !options.security?.fingerprintKey
    ) {
      throw new Error(
        "Indexed segment requires a fingerprint key",
      );
    }
    if (footer.keyedFingerprints) {
      const verification = await fingerprintCheck(
        options.security!.fingerprintKey,
        context,
      );
      if (
        !equalBytes(
          verification,
          footer.fingerprintCheck,
        )
      ) {
        throw new Error(
          "Indexed segment fingerprint key does not match",
        );
      }
    }
    return new IndexedSegmentReader(
      source,
      footer,
      options.cacheBlocks ?? true,
      options.cacheIndexShards ?? true,
      options.security,
      context,
    );
  }

  diagnostics(): IndexedSegmentDiagnostics {
    return {
      documents: this.footer.documentCount,
      blocks: this.footer.blocks.length,
      footerBytes: this.footer.footerBytes,
      dataBytes: this.footer.dataBytes,
      indexBytes: this.footer.indexBytes,
      decodedDataBytes: this.footer.decodedDataBytes,
      indexedFields: this.footer.fields.length,
    };
  }

  clearBlockCache(): void {
    this.blockCache.clear();
  }

  clearIndexCache(): void {
    this.idIndexCache.clear();
  }

  async get(id: string): Promise<JsonDocument | null> {
    validateDocumentId(id);
    const hash = await fingerprint(
      textBytes(id),
      this.effectiveFingerprintKey(),
    );
    const entries = await this.readIdIndexShard(hash[0]!);
    let position = lowerBoundIdIndex(entries, hash);
    while (position < entries.length) {
      const entry = entries[position]!;
      const comparison = compareBytes(entry.hash, hash);
      if (comparison !== 0) {
        break;
      }
      const block = await this.readBlock(entry.block);
      const document = this.decodeBlockRecord(
        block,
        entry.record,
      );
      if (document.id === id) {
        return document;
      }
      position += 1;
    }
    return null;
  }

  async scan(limit = MAX_DOCUMENTS): Promise<JsonDocument[]> {
    return (
      await this.queryInternal(null, validateLimit(limit))
    ).documents;
  }

  async query(
    predicate: IndexedSegmentPredicate,
    limit = MAX_DOCUMENTS,
  ): Promise<IndexedSegmentQueryResult> {
    validatePredicate(predicate);
    return this.queryInternal(
      predicate,
      validateLimit(limit),
    );
  }

  private async queryInternal(
    predicate: IndexedSegmentPredicate | null,
    limit: number,
  ): Promise<IndexedSegmentQueryResult> {
    const fieldIndex =
      predicate === null
        ? -1
        : this.footer.fields.findIndex(
            (field) => field.field === predicate.field,
          );
    const configured =
      fieldIndex >= 0
        ? this.footer.fields[fieldIndex]
        : undefined;
    const canFilter =
      predicate !== null &&
      configured !== undefined &&
      (predicate.operator === "eq" ||
        configured.mode === "range");
    const equalityHash =
      predicate?.operator === "eq"
        ? await scalarHash(
            predicate.value,
            this.effectiveFingerprintKey(),
          )
        : null;
    const documents: JsonDocument[] = [];
    const selectedBlocks: number[] = [];
    let blocksSkipped = 0;
    for (const [blockIndex, block] of this.footer.blocks.entries()) {
      if (
        canFilter &&
        !blockMayMatch(
          block.stats[fieldIndex]!,
          predicate,
          equalityHash,
        )
      ) {
        blocksSkipped += 1;
        continue;
      }
      selectedBlocks.push(blockIndex);
    }
    const loadedBlocks = await this.readBlocks(selectedBlocks);
    for (const blockIndex of selectedBlocks) {
      const decodedBlock = loadedBlocks.get(blockIndex);
      if (!decodedBlock) {
        throw new Error(
          "Indexed segment selected block was not loaded",
        );
      }
      for (
        let index = 0;
        index < decodedBlock.records.length;
        index += 1
      ) {
        const document = this.decodeBlockRecord(
          decodedBlock,
          index,
        );
        if (
          predicate === null ||
          documentMatches(document, predicate)
        ) {
          documents.push(document);
          if (documents.length >= limit) {
            return {
              documents,
              plan: canFilter ? "block-filter" : "scan",
              blocksConsidered: this.footer.blocks.length,
              blocksRead: selectedBlocks.length,
              blocksSkipped,
            };
          }
        }
      }
    }
    return {
      documents,
      plan: canFilter ? "block-filter" : "scan",
      blocksConsidered: this.footer.blocks.length,
      blocksRead: selectedBlocks.length,
      blocksSkipped,
    };
  }

  private decodeBlockRecord(
    block: ParsedBlock,
    recordIndex: number,
  ): JsonDocument {
    const record = block.records[recordIndex];
    if (!record) {
      throw new Error(
        "Indexed segment block record index is invalid",
      );
    }
    assertRange(
      record.offset,
      record.length,
      block.bytes.byteLength,
      "Indexed segment record",
    );
    const value = decodeRecord(
      block.bytes.slice(
        record.offset,
        record.offset + record.length,
      ),
      this.footer.recordEncoding,
    );
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string"
    ) {
      throw new Error(
        "Indexed segment record is not a JSON document",
      );
    }
    return value as JsonDocument;
  }

  private async readBlock(index: number): Promise<ParsedBlock> {
    const cached = this.blockCache.get(index);
    if (cached) {
      return cached;
    }
    const descriptor = this.footer.blocks[index];
    if (!descriptor) {
      throw new Error("Indexed segment block index is invalid");
    }
    const stored = await this.source.read(
      descriptor.offset,
      descriptor.storedLength,
    );
    return this.decodeStoredBlock(index, descriptor, stored);
  }

  private async readBlocks(
    indexes: number[],
  ): Promise<Map<number, ParsedBlock>> {
    const loaded = new Map<number, ParsedBlock>();
    const pending: number[] = [];
    for (const index of indexes) {
      const cached = this.blockCache.get(index);
      if (cached) {
        loaded.set(index, cached);
      } else {
        pending.push(index);
      }
    }
    let cursor = 0;
    while (cursor < pending.length) {
      const firstIndex = pending[cursor]!;
      const first = this.footer.blocks[firstIndex]!;
      let end = first.offset + first.storedLength;
      let next = cursor + 1;
      while (next < pending.length) {
        const nextIndex = pending[next]!;
        const descriptor = this.footer.blocks[nextIndex]!;
        const nextEnd =
          descriptor.offset + descriptor.storedLength;
        if (
          descriptor.offset !== end ||
          nextEnd - first.offset >
            MAX_COALESCED_RANGE_BYTES
        ) {
          break;
        }
        end = nextEnd;
        next += 1;
      }
      const combined = await this.source.read(
        first.offset,
        end - first.offset,
      );
      for (
        let position = cursor;
        position < next;
        position += 1
      ) {
        const index = pending[position]!;
        const descriptor = this.footer.blocks[index]!;
        const start = descriptor.offset - first.offset;
        const stored = combined.slice(
          start,
          start + descriptor.storedLength,
        );
        loaded.set(
          index,
          await this.decodeStoredBlock(
            index,
            descriptor,
            stored,
          ),
        );
      }
      cursor = next;
    }
    return loaded;
  }

  private async decodeStoredBlock(
    index: number,
    descriptor: BlockDescriptor,
    stored: Uint8Array,
  ): Promise<ParsedBlock> {
    if (stored.byteLength !== descriptor.storedLength) {
      throw new Error(
        "Indexed segment stored block length mismatch",
      );
    }
    const hash = (await sha256(stored)).slice(
      0,
      INTEGRITY_HASH_BYTES,
    );
    if (!equalBytes(hash, descriptor.hash)) {
      throw new Error("Indexed segment block hash mismatch");
    }
    const decoded = await decodeEnvelope(
      stored,
      this.security?.resolveKey,
      blockAdditionalData(this.context, index),
      { maximumDecodedBytes: MAX_DECODED_BLOCK_BYTES },
    );
    if (decoded.byteLength !== descriptor.decodedLength) {
      throw new Error(
        "Indexed segment decoded block length mismatch",
      );
    }
    const block = parseBlock(decoded, descriptor.recordCount);
    if (this.cacheBlocks) {
      this.blockCache.set(index, block);
    }
    return block;
  }

  private async readIdIndexShard(
    shard: number,
  ): Promise<IdIndexEntry[]> {
    const cached = this.idIndexCache.get(shard);
    if (cached) {
      return cached;
    }
    const descriptor = this.footer.idIndexShards.get(shard);
    if (!descriptor) {
      return [];
    }
    const stored = await this.source.read(
      descriptor.offset,
      descriptor.storedLength,
    );
    const hash = (await sha256(stored)).slice(
      0,
      INTEGRITY_HASH_BYTES,
    );
    if (!equalBytes(hash, descriptor.hash)) {
      throw new Error(
        "Indexed segment ID index shard hash mismatch",
      );
    }
    const decoded = await decodeEnvelope(
      stored,
      this.security?.resolveKey,
      idIndexAdditionalData(this.context, shard),
      {
        maximumDecodedBytes:
          MAX_DECODED_ID_INDEX_BYTES,
      },
    );
    if (decoded.byteLength !== descriptor.decodedLength) {
      throw new Error(
        "Indexed segment ID index shard length mismatch",
      );
    }
    const entries = decodeIdIndexShard(
      decoded,
      descriptor.entries,
      this.footer.blocks,
      shard,
    );
    if (this.cacheIndexShards) {
      this.idIndexCache.set(shard, entries);
    }
    return entries;
  }

  private effectiveFingerprintKey(): CryptoKey | undefined {
    return this.footer.keyedFingerprints
      ? this.security?.fingerprintKey
      : undefined;
  }
}

function groupRecords(
  records: PreparedRecord[],
  targetBytes: number,
): PreparedRecord[][] {
  const groups: PreparedRecord[][] = [];
  let current: PreparedRecord[] = [];
  let currentBytes = 0;
  for (const record of records) {
    if (
      current.length > 0 &&
      currentBytes + record.bytes.byteLength > targetBytes
    ) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += record.bytes.byteLength;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

async function prepareBlock(
  records: PreparedRecord[],
  fields: IndexedSegmentField[],
  compression: "gzip" | "none",
  blockIndex: number,
  context: string,
  security: IndexedSegmentWriteSecurity | undefined,
): Promise<PreparedBlock> {
  const directoryBytes = 4 + records.length * 8;
  let offset = directoryBytes;
  const descriptors = records.map((record) => {
    const descriptor = {
      hash: record.hash,
      offset,
      length: record.bytes.byteLength,
    };
    offset += record.bytes.byteLength;
    return descriptor;
  });
  const blockWriter = new BinaryWriter();
  blockWriter.writeUint32(records.length);
  descriptors.forEach((record) => {
    blockWriter.writeUint32(record.offset);
    blockWriter.writeUint32(record.length);
  });
  records.forEach((record) =>
    blockWriter.writeBytes(record.bytes),
  );
  const decoded = blockWriter.finish();
  if (decoded.byteLength > MAX_DECODED_BLOCK_BYTES) {
    throw new Error(
      "Indexed segment block exceeds its decoded limit",
    );
  }
  const bytes = await encodeEnvelope(
    decoded,
    envelopeOptions(
      compression,
      blockAdditionalData(context, blockIndex),
      security,
    ),
  );
  if (bytes.byteLength > MAX_STORED_BLOCK_BYTES) {
    throw new Error(
      "Indexed segment stored block exceeds its limit",
    );
  }
  return {
    bytes,
    decodedLength: decoded.byteLength,
    hash: (await sha256(bytes)).slice(
      0,
      INTEGRITY_HASH_BYTES,
    ),
    records: descriptors,
    stats: await Promise.all(
      fields.map((field) =>
        fieldStats(
          records.map((record) => record.document),
          field,
          security?.fingerprintKey,
        ),
      ),
    ),
  };
}

async function fieldStats(
  documents: JsonDocument[],
  definition: IndexedSegmentField,
  fingerprintKey: CryptoKey | undefined,
): Promise<FieldStats> {
  const values = documents
    .map((document) =>
      ownValue(
        document as Record<string, JsonValue>,
        definition.field,
      ),
    )
    .filter(isPrimitive);
  const bloom = new Uint8Array(BLOOM_BYTES);
  await Promise.all(
    values.map(async (value) =>
      bloomAdd(
        bloom,
        await scalarHash(value, fingerprintKey),
      ),
    ),
  );
  if (values.length === 0) {
    return { kind: "none", bloom };
  }
  const kinds = new Set(values.map(scalarKind));
  if (kinds.size !== 1) {
    return { kind: "mixed", bloom };
  }
  const kind = scalarKind(values[0]!);
  if (
    definition.mode !== "range" ||
    (kind !== "string" && kind !== "number")
  ) {
    return { kind, bloom };
  }
  const comparable = values as Array<string | number>;
  let min = comparable[0]!;
  let max = comparable[0]!;
  for (const value of comparable.slice(1)) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return {
    kind,
    bloom,
    min,
    max,
  };
}

function encodeFooter(
  recordEncoding: "json" | "binary",
  keyedFingerprints: boolean,
  fingerprintVerification: Uint8Array,
  documentCount: number,
  fields: IndexedSegmentField[],
  blocks: BlockDescriptor[],
  idIndexShards: IdIndexShardDescriptor[],
): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeBytes(FOOTER_MAGIC);
  writer.writeUint16(FORMAT_VERSION);
  writer.writeUint16(
    (recordEncoding === "binary"
      ? FOOTER_FLAG_BINARY_RECORDS
      : 0) |
      (keyedFingerprints
        ? FOOTER_FLAG_KEYED_FINGERPRINTS
        : 0),
  );
  writer.writeUint32(blocks.length);
  writer.writeUint32(documentCount);
  writer.writeUint16(fields.length);
  writer.writeUint8(FINGERPRINT_BYTES);
  writer.writeUint8(0);
  writer.writeUint16(idIndexShards.length);
  writer.writeUint16(0);
  if (
    fingerprintVerification.byteLength !==
    (keyedFingerprints ? FINGERPRINT_CHECK_BYTES : 0)
  ) {
    throw new Error(
      "Indexed segment fingerprint verification is invalid",
    );
  }
  writer.writeUint8(fingerprintVerification.byteLength);
  writer.writeUint8(0);
  writer.writeUint16(0);
  writer.writeBytes(fingerprintVerification);
  for (const field of fields) {
    writer.writeString16(field.field);
    writer.writeUint8(
      field.mode === "equality" ? 1 : 2,
    );
    writer.writeUint8(0);
  }
  for (const block of blocks) {
    writer.writeUint64(block.offset);
    writer.writeUint32(block.storedLength);
    writer.writeUint32(block.decodedLength);
    writer.writeUint32(block.recordCount);
    writer.writeUint8(0);
    writer.writeUint8(0);
    writer.writeUint16(0);
    writer.writeBytes(block.hash);
    for (const stats of block.stats) {
      encodeFieldStats(writer, stats);
    }
  }
  for (const shard of idIndexShards) {
    writer.writeUint8(shard.shard);
    writer.writeUint8(0);
    writer.writeUint16(0);
    writer.writeUint64(shard.offset);
    writer.writeUint32(shard.storedLength);
    writer.writeUint32(shard.decodedLength);
    writer.writeUint32(shard.entries);
    writer.writeBytes(shard.hash);
  }
  return writer.finish();
}

function parseFooter(
  bytes: Uint8Array,
  prefixBytes: number,
  storedFooterBytes: number,
): ParsedFooter {
  const reader = new BinaryReader(bytes);
  assertMagic(reader.readBytes(4), FOOTER_MAGIC, "footer");
  const version = reader.readUint16();
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported indexed segment version ${version}`,
    );
  }
  const flags = reader.readUint16();
  if (
    (flags &
      ~(
        FOOTER_FLAG_BINARY_RECORDS |
        FOOTER_FLAG_KEYED_FINGERPRINTS
      )) !==
    0
  ) {
    throw new Error("Indexed segment footer has unsupported flags");
  }
  const blockCount = reader.readUint32();
  const recordCount = reader.readUint32();
  const fieldCount = reader.readUint16();
  const hashBytes = reader.readUint8();
  reader.readUint8();
  const idIndexShardCount = reader.readUint16();
  reader.readUint16();
  const fingerprintCheckLength = reader.readUint8();
  reader.readUint8();
  reader.readUint16();
  if (
    blockCount > MAX_DOCUMENTS ||
    recordCount > MAX_DOCUMENTS ||
    fieldCount > MAX_FIELDS ||
    idIndexShardCount > 256 ||
    hashBytes !== FINGERPRINT_BYTES
  ) {
    throw new Error("Indexed segment footer counts are invalid");
  }
  const keyedFingerprints =
    (flags & FOOTER_FLAG_KEYED_FINGERPRINTS) !== 0;
  if (
    fingerprintCheckLength !==
    (keyedFingerprints ? FINGERPRINT_CHECK_BYTES : 0)
  ) {
    throw new Error(
      "Indexed segment fingerprint verification length is invalid",
    );
  }
  const fingerprintVerification = reader.readBytes(
    fingerprintCheckLength,
  );
  const fields = Array.from({ length: fieldCount }, () => {
    const field = reader.readString16();
    const modeValue = reader.readUint8();
    reader.readUint8();
    return validateField({
      field,
      mode:
        modeValue === 1
          ? "equality"
          : modeValue === 2
            ? "range"
            : invalidMode(),
    });
  });
  const blocks: BlockDescriptor[] = [];
  let countedRecords = 0;
  let decodedDataBytes = 0;
  let storedDataBytes = 0;
  let expectedDataOffset = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const offset = reader.readUint64();
    const storedLength = reader.readUint32();
    const decodedLength = reader.readUint32();
    const blockRecords = reader.readUint32();
    const blockFlags = reader.readUint8();
    reader.readUint8();
    reader.readUint16();
    const hash = reader.readBytes(INTEGRITY_HASH_BYTES);
    if (
      blockFlags !== 0 ||
      decodedLength > MAX_DECODED_BLOCK_BYTES ||
      storedLength > MAX_STORED_BLOCK_BYTES ||
      offset !== expectedDataOffset ||
      countedRecords + blockRecords > recordCount
    ) {
      throw new Error(
        "Indexed segment block descriptor is invalid",
      );
    }
    assertRange(
      offset,
      storedLength,
      prefixBytes,
      "Indexed segment block",
    );
    countedRecords += blockRecords;
    decodedDataBytes += decodedLength;
    storedDataBytes += storedLength;
    expectedDataOffset += storedLength;
    blocks.push({
      offset,
      storedLength,
      decodedLength,
      recordCount: blockRecords,
      hash,
      stats: Array.from({ length: fieldCount }, () =>
        decodeFieldStats(reader),
      ),
    });
  }
  if (countedRecords !== recordCount) {
    throw new Error(
      "Indexed segment block record counts are incomplete",
    );
  }
  const idIndexShards = new Map<
    number,
    IdIndexShardDescriptor
  >();
  let indexedRecords = 0;
  let indexBytes = 0;
  let previousShard = -1;
  for (let index = 0; index < idIndexShardCount; index += 1) {
    const shard = reader.readUint8();
    reader.readUint8();
    reader.readUint16();
    const offset = reader.readUint64();
    const storedLength = reader.readUint32();
    const decodedLength = reader.readUint32();
    const entries = reader.readUint32();
    const hash = reader.readBytes(INTEGRITY_HASH_BYTES);
    if (
      idIndexShards.has(shard) ||
      shard <= previousShard ||
      offset !== expectedDataOffset ||
      entries < 1 ||
      decodedLength > MAX_DECODED_ID_INDEX_BYTES ||
      storedLength > MAX_STORED_ID_INDEX_BYTES ||
      indexedRecords + entries > recordCount
    ) {
      throw new Error(
        "Indexed segment ID index shard descriptor is invalid",
      );
    }
    assertRange(
      offset,
      storedLength,
      prefixBytes,
      "Indexed segment ID index shard",
    );
    indexedRecords += entries;
    indexBytes += storedLength;
    expectedDataOffset += storedLength;
    previousShard = shard;
    idIndexShards.set(shard, {
      shard,
      offset,
      storedLength,
      decodedLength,
      entries,
      hash,
    });
  }
  if (indexedRecords !== recordCount) {
    throw new Error(
      "Indexed segment ID index is incomplete",
    );
  }
  if (expectedDataOffset !== prefixBytes) {
    throw new Error(
      "Indexed segment data ranges do not fill the segment",
    );
  }
  if (!reader.done()) {
    throw new Error("Indexed segment footer has trailing bytes");
  }
  return {
    recordEncoding:
      (flags & FOOTER_FLAG_BINARY_RECORDS) !== 0
        ? "binary"
        : "json",
    keyedFingerprints:
      keyedFingerprints,
    fingerprintCheck: fingerprintVerification,
    documentCount: recordCount,
    fields,
    blocks,
    idIndexShards,
    footerBytes: storedFooterBytes,
    dataBytes: storedDataBytes,
    indexBytes,
    decodedDataBytes,
  };
}

function encodeFieldStats(
  writer: BinaryWriter,
  stats: FieldStats,
): void {
  writer.writeUint8(kindCode(stats.kind));
  const hasBounds =
    stats.min !== undefined && stats.max !== undefined;
  writer.writeUint8(hasBounds ? 1 : 0);
  writer.writeUint16(0);
  writer.writeBytes(stats.bloom);
  if (hasBounds) {
    encodeBound(writer, stats.kind, stats.min!);
    encodeBound(writer, stats.kind, stats.max!);
  }
}

function encodeIdIndexShard(
  entries: IdIndexEntry[],
): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeUint32(entries.length);
  for (const entry of entries) {
    writer.writeBytes(entry.hash.slice(1));
    writer.writeUint32(entry.block);
    writer.writeUint32(entry.record);
  }
  return writer.finish();
}

function decodeIdIndexShard(
  bytes: Uint8Array,
  expectedEntries: number,
  blocks: BlockDescriptor[],
  shard: number,
): IdIndexEntry[] {
  const reader = new BinaryReader(bytes);
  const count = reader.readUint32();
  if (count !== expectedEntries) {
    throw new Error(
      "Indexed segment ID index shard count mismatch",
    );
  }
  const entries = Array.from(
    { length: count },
    (): IdIndexEntry => ({
      hash: concatenate([
        Uint8Array.of(shard),
        reader.readBytes(FINGERPRINT_BYTES - 1),
      ]),
      block: reader.readUint32(),
      record: reader.readUint32(),
    }),
  );
  const pointers = new Set<string>();
  for (const entry of entries) {
    const block = blocks[entry.block];
    const pointer = `${entry.block}:${entry.record}`;
    if (
      entry.hash[0] !== shard ||
      !block ||
      entry.record >= block.recordCount ||
      pointers.has(pointer)
    ) {
      throw new Error(
        "Indexed segment ID index entry is invalid",
      );
    }
    pointers.add(pointer);
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (
      compareBytes(
        entries[index - 1]!.hash,
        entries[index]!.hash,
      ) > 0
    ) {
      throw new Error(
        "Indexed segment ID index shard is not sorted",
      );
    }
  }
  if (!reader.done()) {
    throw new Error(
      "Indexed segment ID index shard has trailing bytes",
    );
  }
  return entries;
}

function parseBlock(
  bytes: Uint8Array,
  expectedRecords: number,
): ParsedBlock {
  if (bytes.byteLength < 4) {
    throw new Error("Indexed segment block is truncated");
  }
  const view = dataView(bytes);
  const count = view.getUint32(0, false);
  if (count !== expectedRecords) {
    throw new Error(
      "Indexed segment block record count mismatch",
    );
  }
  const directoryBytes = 4 + count * 8;
  if (directoryBytes > bytes.byteLength) {
    throw new Error(
      "Indexed segment block directory is truncated",
    );
  }
  const records = Array.from({ length: count }, (_, index) => ({
    offset: view.getUint32(4 + index * 8, false),
    length: view.getUint32(8 + index * 8, false),
  }));
  let expectedOffset = directoryBytes;
  for (const record of records) {
    if (record.offset !== expectedOffset) {
      throw new Error(
        "Indexed segment block record offsets are not contiguous",
      );
    }
    assertRange(
      record.offset,
      record.length,
      bytes.byteLength,
      "Indexed segment block record",
    );
    expectedOffset += record.length;
  }
  if (expectedOffset !== bytes.byteLength) {
    throw new Error(
      "Indexed segment block has trailing bytes",
    );
  }
  return { bytes, records };
}

function decodeFieldStats(reader: BinaryReader): FieldStats {
  const kind = codeKind(reader.readUint8());
  const hasBounds = reader.readUint8() === 1;
  reader.readUint16();
  const bloom = reader.readBytes(BLOOM_BYTES);
  if (!hasBounds) {
    return { kind, bloom };
  }
  if (kind !== "string" && kind !== "number") {
    throw new Error(
      "Indexed segment field bounds use an invalid scalar kind",
    );
  }
  return {
    kind,
    bloom,
    min: decodeBound(reader, kind),
    max: decodeBound(reader, kind),
  };
}

function encodeBound(
  writer: BinaryWriter,
  kind: ScalarKind,
  value: JsonPrimitive,
): void {
  if (kind === "string" && typeof value === "string") {
    writer.writeString32(value);
    return;
  }
  if (kind === "number" && typeof value === "number") {
    writer.writeFloat64(value);
    return;
  }
  throw new Error("Indexed segment field bound is invalid");
}

function decodeBound(
  reader: BinaryReader,
  kind: "string" | "number",
): string | number {
  return kind === "string"
    ? reader.readString32()
    : reader.readFloat64();
}

function blockMayMatch(
  stats: FieldStats,
  predicate: IndexedSegmentPredicate,
  equalityHash: Uint8Array | null,
): boolean {
  if (stats.kind === "none") {
    return false;
  }
  if (predicate.operator === "eq") {
    if (!equalityHash) {
      throw new Error(
        "Indexed segment equality hash is unavailable",
      );
    }
    return bloomMayContain(
      stats.bloom,
      equalityHash,
    );
  }
  if (stats.kind === "mixed") {
    return true;
  }
  if (typeof predicate.lower === "number") {
    return (
      typeof predicate.upper === "number" &&
      stats.kind === "number" &&
      typeof stats.min === "number" &&
      typeof stats.max === "number" &&
      !(
        stats.max < predicate.lower ||
        stats.min > predicate.upper
      )
    );
  }
  return (
    typeof predicate.upper === "string" &&
    stats.kind === "string" &&
    typeof stats.min === "string" &&
    typeof stats.max === "string" &&
    !(
      stats.max < predicate.lower ||
      stats.min > predicate.upper
    )
  );
}

function documentMatches(
  document: JsonDocument,
  predicate: IndexedSegmentPredicate,
): boolean {
  const value = ownValue(
    document as Record<string, JsonValue>,
    predicate.field,
  );
  if (!isPrimitive(value)) {
    return false;
  }
  if (predicate.operator === "eq") {
    return value === predicate.value;
  }
  return (
    typeof value === typeof predicate.lower &&
    (typeof value === "string" || typeof value === "number") &&
    value >= predicate.lower &&
    value <= predicate.upper
  );
}

function lowerBoundIdIndex(
  entries: IdIndexEntry[],
  hash: Uint8Array,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const comparison = compareBytes(
      entries[middle]!.hash,
      hash,
    );
    if (comparison < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function validateFields(
  fields: IndexedSegmentField[],
): IndexedSegmentField[] {
  if (fields.length > MAX_FIELDS) {
    throw new Error(
      `Indexed segment supports at most ${MAX_FIELDS} indexed fields`,
    );
  }
  const names = new Set<string>();
  return [...fields]
    .map(validateField)
    .sort((left, right) =>
      compareText(left.field, right.field),
    )
    .map((field) => {
      if (names.has(field.field)) {
        throw new Error(
          `Indexed segment field ${field.field} is duplicated`,
        );
      }
      names.add(field.field);
      return field;
    });
}

function validateWriteSecurity(
  security: IndexedSegmentWriteSecurity | undefined,
): void {
  if (!security) {
    return;
  }
  if (
    security.key.algorithm.name !== "AES-GCM" ||
    !security.key.usages.includes("encrypt") ||
    security.fingerprintKey.algorithm.name !== "HMAC" ||
    !security.fingerprintKey.usages.includes("sign") ||
    security.keyId.length < 1 ||
    security.keyId.length > 128
  ) {
    throw new Error(
      "Indexed segment security configuration is invalid",
    );
  }
  validateContext(security.context ?? "experimental");
}

function validateReadSecurity(
  security: IndexedSegmentReadSecurity | undefined,
): void {
  if (!security) {
    return;
  }
  if (
    security.fingerprintKey.algorithm.name !== "HMAC" ||
    !security.fingerprintKey.usages.includes("sign")
  ) {
    throw new Error(
      "Indexed segment read security configuration is invalid",
    );
  }
  validateContext(security.context ?? "experimental");
}

function validateContext(context: string): void {
  if (context.length < 1 || context.length > 512) {
    throw new Error(
      "Indexed segment context must be 1-512 characters",
    );
  }
}

function validateField(
  field: IndexedSegmentField,
): IndexedSegmentField {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(field.field) ||
    field.field === "__proto__" ||
    field.field === "prototype" ||
    field.field === "constructor" ||
    (field.mode !== "equality" && field.mode !== "range")
  ) {
    throw new Error("Indexed segment field definition is invalid");
  }
  return { ...field };
}

function envelopeOptions(
  compression: "gzip" | "none",
  additionalData: Uint8Array,
  security: IndexedSegmentWriteSecurity | undefined,
): EnvelopeEncodeOptions {
  return {
    compression,
    additionalData,
    ...(security
      ? {
          key: security.key,
          keyId: security.keyId,
        }
      : {}),
  };
}

function footerAdditionalData(context: string): Uint8Array {
  validateContext(context);
  return textBytes(`TIS1\u0000${context}\u0000footer`);
}

function blockAdditionalData(
  context: string,
  blockIndex: number,
): Uint8Array {
  validateContext(context);
  return textBytes(
    `TIS1\u0000${context}\u0000block\u0000${blockIndex}`,
  );
}

function idIndexAdditionalData(
  context: string,
  shard: number,
): Uint8Array {
  validateContext(context);
  return textBytes(
    `TIS1\u0000${context}\u0000id-index\u0000${shard}`,
  );
}

function validatePredicate(
  predicate: IndexedSegmentPredicate,
): void {
  validateField({
    field: predicate.field,
    mode:
      predicate.operator === "between"
        ? "range"
        : "equality",
  });
  if (
    predicate.operator === "between" &&
    (typeof predicate.lower !== typeof predicate.upper ||
      predicate.lower > predicate.upper)
  ) {
    throw new Error(
      "Indexed segment range predicate is invalid",
    );
  }
}

function validateDocumentId(id: string): void {
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 1_024
  ) {
    throw new Error(
      "Indexed segment document id must be 1-1024 characters",
    );
  }
}

function encodeRecord(
  document: JsonDocument,
  encoding: "json" | "binary",
): Uint8Array {
  if (encoding === "json") {
    return encodeCanonicalJson(document);
  }
  const writer = new BinaryWriter();
  encodeBinaryValue(writer, document);
  return writer.finish();
}

function decodeRecord(
  bytes: Uint8Array,
  encoding: "json" | "binary",
): unknown {
  if (encoding === "json") {
    return decodeJson<unknown>(bytes);
  }
  const reader = new BinaryReader(bytes);
  const value = decodeBinaryValue(reader, 0);
  if (!reader.done()) {
    throw new Error(
      "Indexed segment binary record has trailing bytes",
    );
  }
  return value;
}

function encodeBinaryValue(
  writer: BinaryWriter,
  value: JsonValue,
): void {
  if (value === null) {
    writer.writeUint8(0);
    return;
  }
  if (value === false) {
    writer.writeUint8(1);
    return;
  }
  if (value === true) {
    writer.writeUint8(2);
    return;
  }
  if (typeof value === "number") {
    writer.writeUint8(3);
    writer.writeFloat64(value);
    return;
  }
  if (typeof value === "string") {
    writer.writeUint8(4);
    writer.writeString32(value);
    return;
  }
  if (Array.isArray(value)) {
    writer.writeUint8(5);
    writer.writeUint32(value.length);
    value.forEach((item) =>
      encodeBinaryValue(writer, item),
    );
    return;
  }
  writer.writeUint8(6);
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareText(left, right),
  );
  writer.writeUint32(entries.length);
  for (const [key, item] of entries) {
    writer.writeString32(key);
    encodeBinaryValue(writer, item);
  }
}

function decodeBinaryValue(
  reader: BinaryReader,
  depth: number,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(
      `Indexed segment binary JSON exceeds depth ${MAX_JSON_DEPTH}`,
    );
  }
  const type = reader.readUint8();
  if (type === 0) {
    return null;
  }
  if (type === 1) {
    return false;
  }
  if (type === 2) {
    return true;
  }
  if (type === 3) {
    return reader.readFloat64();
  }
  if (type === 4) {
    return reader.readString32();
  }
  if (type === 5) {
    const length = reader.readUint32();
    if (length > MAX_DOCUMENTS) {
      throw new Error(
        "Indexed segment binary array is too large",
      );
    }
    return Array.from({ length }, () =>
      decodeBinaryValue(reader, depth + 1),
    );
  }
  if (type === 6) {
    const length = reader.readUint32();
    if (length > MAX_DOCUMENTS) {
      throw new Error(
        "Indexed segment binary object is too large",
      );
    }
    const object: Record<string, JsonValue> = {};
    for (let index = 0; index < length; index += 1) {
      const key = reader.readString32();
      if (Object.hasOwn(object, key)) {
        throw new Error(
          "Indexed segment binary object has duplicate keys",
        );
      }
      Object.defineProperty(object, key, {
        value: decodeBinaryValue(reader, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return object;
  }
  throw new Error(
    `Indexed segment binary JSON type ${type} is invalid`,
  );
}

function snapshotDocument(document: JsonDocument): JsonDocument {
  if (!Object.hasOwn(document, "id")) {
    throw new Error(
      "Indexed segment document requires an own id field",
    );
  }
  validateJsonValue(document);
  validateDocumentId(document.id);
  return decodeJson<JsonDocument>(
    encodeCanonicalJson(document),
  );
}

function encodeCanonicalJson(value: JsonValue): Uint8Array {
  return textBytes(canonicalStringify(value));
}

function canonicalStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(
        "Indexed segment contains an unsupported JSON value",
      );
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalStringify(item))
      .join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareText(left, right))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalStringify(item)}`,
    )
    .join(",")}}`;
}

function validateJsonValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(
      `Indexed segment JSON exceeds depth ${MAX_JSON_DEPTH}`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Indexed segment JSON numbers must be finite",
      );
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(
      "Indexed segment input must contain JSON values",
    );
  }
  if (seen.has(value)) {
    throw new Error(
      "Indexed segment JSON cannot contain cycles",
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) =>
      validateJsonValue(item, depth + 1, seen),
    );
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new Error(
      "Indexed segment input must contain plain JSON objects",
    );
  }
  for (const item of Object.values(value)) {
    validateJsonValue(item, depth + 1, seen);
  }
  seen.delete(value);
}

function validateLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DOCUMENTS
  ) {
    throw new Error(
      `Indexed segment limit must be 1-${MAX_DOCUMENTS}`,
    );
  }
  return limit;
}

function isPrimitive(
  value: JsonValue | undefined,
): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function scalarKind(value: JsonPrimitive): ScalarKind {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "boolean";
}

async function scalarHash(
  value: JsonPrimitive,
  key: CryptoKey | undefined,
): Promise<Uint8Array> {
  return fingerprint(
    textBytes(`${scalarKind(value)}:${JSON.stringify(value)}`),
    key,
  );
}

async function bloomAdd(
  bloom: Uint8Array,
  hash: Uint8Array,
): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    const bit =
      (((hash[index * 2] ?? 0) << 8) |
        (hash[index * 2 + 1] ?? 0)) %
      (BLOOM_BYTES * 8);
    bloom[Math.floor(bit / 8)]! |= 1 << (bit % 8);
  }
}

function bloomMayContain(
  bloom: Uint8Array,
  hash: Uint8Array,
): boolean {
  for (let index = 0; index < 4; index += 1) {
    const bit =
      (((hash[index * 2] ?? 0) << 8) |
        (hash[index * 2 + 1] ?? 0)) %
      (BLOOM_BYTES * 8);
    if (
      (bloom[Math.floor(bit / 8)]! & (1 << (bit % 8))) ===
      0
    ) {
      return false;
    }
  }
  return true;
}

function kindCode(kind: ScalarKind): number {
  return {
    none: 0,
    string: 1,
    number: 2,
    boolean: 3,
    null: 4,
    mixed: 5,
  }[kind];
}

function codeKind(code: number): ScalarKind {
  const kind = [
    "none",
    "string",
    "number",
    "boolean",
    "null",
    "mixed",
  ][code];
  if (!kind) {
    throw new Error("Indexed segment field stats kind is invalid");
  }
  return kind as ScalarKind;
}

function invalidMode(): never {
  throw new Error("Indexed segment field mode is invalid");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      toBufferView(bytes),
    ),
  );
}

async function fingerprint(
  bytes: Uint8Array,
  key: CryptoKey | undefined,
): Promise<Uint8Array> {
  const digest = key
    ? new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          toBufferView(bytes),
        ),
      )
    : await sha256(bytes);
  return digest.slice(0, FINGERPRINT_BYTES);
}

async function fingerprintCheck(
  key: CryptoKey,
  context: string,
): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toBufferView(
        textBytes(
          `TIS1\u0000${context}\u0000fingerprint-check`,
        ),
      ),
    ),
  );
  return digest.slice(0, FINGERPRINT_CHECK_BYTES);
}

class BinaryWriter {
  private readonly parts: Uint8Array[] = [];

  writeUint8(value: number): void {
    const bytes = new Uint8Array(1);
    bytes[0] = value;
    this.parts.push(bytes);
  }

  writeUint16(value: number): void {
    const bytes = new Uint8Array(2);
    dataView(bytes).setUint16(0, value, false);
    this.parts.push(bytes);
  }

  writeUint32(value: number): void {
    const bytes = new Uint8Array(4);
    dataView(bytes).setUint32(0, value, false);
    this.parts.push(bytes);
  }

  writeUint64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Indexed segment uint64 value is invalid");
    }
    const bytes = new Uint8Array(8);
    dataView(bytes).setBigUint64(0, BigInt(value), false);
    this.parts.push(bytes);
  }

  writeFloat64(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error("Indexed segment number is not finite");
    }
    const bytes = new Uint8Array(8);
    dataView(bytes).setFloat64(0, value, false);
    this.parts.push(bytes);
  }

  writeString16(value: string): void {
    const bytes = textBytes(value);
    if (bytes.byteLength > 65_535) {
      throw new Error("Indexed segment string is too long");
    }
    this.writeUint16(bytes.byteLength);
    this.writeBytes(bytes);
  }

  writeString32(value: string): void {
    const bytes = textBytes(value);
    this.writeUint32(bytes.byteLength);
    this.writeBytes(bytes);
  }

  writeBytes(bytes: Uint8Array): void {
    this.parts.push(bytes);
  }

  finish(): Uint8Array {
    return concatenate(this.parts);
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readUint8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }

  readUint16(): number {
    this.require(2);
    const value = dataView(this.bytes).getUint16(
      this.offset,
      false,
    );
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    this.require(4);
    const value = dataView(this.bytes).getUint32(
      this.offset,
      false,
    );
    this.offset += 4;
    return value;
  }

  readUint64(): number {
    this.require(8);
    const value = dataView(this.bytes).getBigUint64(
      this.offset,
      false,
    );
    this.offset += 8;
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new Error(
        "Indexed segment uint64 exceeds safe integer range",
      );
    }
    return number;
  }

  readFloat64(): number {
    this.require(8);
    const value = dataView(this.bytes).getFloat64(
      this.offset,
      false,
    );
    this.offset += 8;
    if (!Number.isFinite(value)) {
      throw new Error(
        "Indexed segment field bound is not finite",
      );
    }
    return value;
  }

  readString16(): string {
    return UTF8_DECODER.decode(
      this.readBytes(this.readUint16()),
    );
  }

  readString32(): string {
    return UTF8_DECODER.decode(
      this.readBytes(this.readUint32()),
    );
  }

  readBytes(length: number): Uint8Array {
    this.require(length);
    const value = this.bytes.slice(
      this.offset,
      this.offset + length,
    );
    this.offset += length;
    return value;
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  private require(length: number): void {
    if (
      !Number.isInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.byteLength
    ) {
      throw new Error("Indexed segment footer is truncated");
    }
  }
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce(
    (total, part) => total + part.byteLength,
    0,
  );
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function compareBytes(
  left: Uint8Array,
  right: Uint8Array,
): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function assertMagic(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  if (!equalBytes(actual, expected)) {
    throw new Error(`Indexed ${label} magic is invalid`);
  }
}

function assertRange(
  offset: number,
  length: number,
  total: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > total
  ) {
    throw new Error(`${label} range is invalid`);
  }
}

function parseContentRange(value: string | null): {
  start: number;
  end: number;
  total: number;
} {
  const match =
    /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) {
    throw new Error(
      "Indexed segment response is missing Content-Range",
    );
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total)
  ) {
    throw new Error(
      "Indexed segment Content-Range is invalid",
    );
  }
  return { start, end, total };
}

async function readExactResponse(
  response: Response,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > MAX_RANGE_RESPONSE_BYTES
  ) {
    throw new Error(
      "Indexed segment response length exceeds the format limit",
    );
  }
  const declaredLength = response.headers.get(
    "content-length",
  );
  if (
    declaredLength !== null &&
    Number(declaredLength) !== expectedBytes
  ) {
    throw new Error(
      "Indexed segment response Content-Length is invalid",
    );
  }
  if (!response.body) {
    if (expectedBytes === 0) {
      return new Uint8Array();
    }
    throw new Error("Indexed segment response has no body");
  }
  const reader = response.body.getReader();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (offset + result.value.byteLength > expectedBytes) {
        await reader.cancel();
        throw new Error(
          "Indexed segment range response is larger than requested",
        );
      }
      output.set(result.value, offset);
      offset += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) {
    throw new Error(
      "Indexed segment range response length is invalid",
    );
  }
  return output;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

function textBytes(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value);
}

function toBufferView(
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(
    new ArrayBuffer(bytes.byteLength),
  );
  copy.set(bytes);
  return copy;
}
