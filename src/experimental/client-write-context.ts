import type {
  JsonDocument,
  JsonValue,
  ObjectStore,
  PutConditions,
  StoredObject,
} from "../core.js";
import { ContentAddressedTrieEngine } from "../engines/content-trie.js";
import {
  encodeSecondaryIndexPage,
  secondaryIndexPageFromJson,
  type CollectionIndexConfiguration,
  type SecondaryIndexReferences,
} from "../secondary-index.js";
import {
  encodeJson,
  validateName,
} from "../shared-utils.js";
import {
  trieHeadKey,
  trieIndexKey,
  trieNodeKey,
  type TrieHead,
} from "../trie-protocol.js";

export const CLIENT_WRITE_CONTEXT_MAX_OBJECTS = 16;
export const CLIENT_WRITE_CONTEXT_MAX_DECODED_BYTES =
  16 * 1024 * 1024;
export const CLIENT_WRITE_CONTEXT_MAX_TTL_MS =
  5 * 60 * 1_000;

export type ClientWriteContextSigner = (
  bytes: Uint8Array,
) => Promise<string> | string;

export type ClientTrieWriteContext = {
  version: 1;
  scopeId: string;
  collection: string;
  layoutGeneration: string;
  issuedAt: number;
  expiresAt: number;
  head: {
    etag: string | null;
    value: TrieHead;
  };
  objects: Array<{
    key: string;
    value: JsonValue;
  }>;
  signature: string;
};

export type ClientAssistedTrieWriteResult = {
  mode: "assisted" | "fallback";
  fallbackReason:
    | "missing"
    | "invalid"
    | "expired"
    | "stale"
    | null;
  contextHits: number;
  authoritativeReadsDuringAttempt: number;
  verifiedObjects: number;
  verifiedDecodedBytes: number;
  verificationMs: number;
};

export class ClientWriteContextError extends Error {
  constructor(
    readonly reason: "invalid" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "ClientWriteContextError";
  }
}

export async function issueClientTrieWriteContext(options: {
  scopeId: string;
  collection: string;
  layoutGeneration: string;
  issuedAt: number;
  expiresAt: number;
  head: {
    etag: string | null;
    value: TrieHead;
  };
  objects: Array<{
    key: string;
    value: JsonValue;
  }>;
  sign: ClientWriteContextSigner;
}): Promise<ClientTrieWriteContext> {
  const unsigned = {
    version: 1 as const,
    scopeId: options.scopeId,
    collection: validateName(
      options.collection,
      "Collection",
    ),
    layoutGeneration: options.layoutGeneration,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    head: structuredClone(options.head),
    objects: structuredClone(options.objects),
  };
  const payload = signedPayload(unsigned);
  return {
    ...unsigned,
    signature: await options.sign(payload),
  };
}

export async function applyClientAssistedTrieWrite(options: {
  store: ObjectStore;
  addressNode: (
    bytes: Uint8Array,
  ) => Promise<string> | string;
  verifySignature: ClientWriteContextSigner;
  scopeId: string;
  collection: string;
  layoutGeneration: string;
  document: JsonDocument;
  context?: unknown;
  indexConfiguration?: CollectionIndexConfiguration;
  maxRetries?: number;
  now?: number;
}): Promise<ClientAssistedTrieWriteResult> {
  const baseline = () =>
    new ContentAddressedTrieEngine(
      options.store,
      options.maxRetries ?? 40,
      options.addressNode,
      false,
      options.indexConfiguration ?? {},
    ).put(
      options.collection,
      options.document.id,
      options.document,
    );
  if (options.context === undefined) {
    await baseline();
    return fallbackResult("missing");
  }

  const started = performance.now();
  let verified: VerifiedClientWriteContext;
  try {
    verified = await verifyClientTrieWriteContext({
      value: options.context,
      scopeId: options.scopeId,
      collection: options.collection,
      layoutGeneration: options.layoutGeneration,
      addressNode: options.addressNode,
      verifySignature: options.verifySignature,
      now: options.now ?? Date.now(),
    });
  } catch (error) {
    if (!(error instanceof ClientWriteContextError)) {
      throw error;
    }
    await baseline();
    return {
      ...fallbackResult(error.reason),
      verificationMs: round(performance.now() - started),
    };
  }
  const verificationMs = round(
    performance.now() - started,
  );
  const overlay = new ClientContextObjectStore(
    options.store,
    verified.objects,
  );
  const assisted = new ContentAddressedTrieEngine(
    overlay,
    options.maxRetries ?? 40,
    options.addressNode,
    false,
    options.indexConfiguration ?? {},
  );
  const committed = await assisted.rewriteIfHeadUnchanged(
    options.collection,
    [options.document],
    verified.headEtag,
  );
  if (!committed) {
    await baseline();
    return {
      mode: "fallback",
      fallbackReason: "stale",
      contextHits: overlay.contextHits,
      authoritativeReadsDuringAttempt:
        overlay.authoritativeReads,
      verifiedObjects: verified.verifiedObjects,
      verifiedDecodedBytes:
        verified.verifiedDecodedBytes,
      verificationMs,
    };
  }
  return {
    mode: "assisted",
    fallbackReason: null,
    contextHits: overlay.contextHits,
    authoritativeReadsDuringAttempt:
      overlay.authoritativeReads,
    verifiedObjects: verified.verifiedObjects,
    verifiedDecodedBytes:
      verified.verifiedDecodedBytes,
    verificationMs,
  };
}

type UnsignedClientTrieWriteContext = Omit<
  ClientTrieWriteContext,
  "signature"
>;

type VerifiedClientWriteContext = {
  headEtag: string | null;
  objects: Map<string, StoredObject | null>;
  verifiedObjects: number;
  verifiedDecodedBytes: number;
};

async function verifyClientTrieWriteContext(options: {
  value: unknown;
  scopeId: string;
  collection: string;
  layoutGeneration: string;
  addressNode: (
    bytes: Uint8Array,
  ) => Promise<string> | string;
  verifySignature: ClientWriteContextSigner;
  now: number;
}): Promise<VerifiedClientWriteContext> {
  const context = parseContext(options.value);
  const collection = validateName(
    options.collection,
    "Collection",
  );
  if (
    context.scopeId !== options.scopeId ||
    context.collection !== collection ||
    context.layoutGeneration !==
      options.layoutGeneration
  ) {
    throw invalid("Client write context scope is invalid");
  }
  if (
    context.issuedAt > options.now + 30_000 ||
    context.expiresAt <= options.now ||
    context.expiresAt <= context.issuedAt ||
    context.expiresAt - context.issuedAt >
      CLIENT_WRITE_CONTEXT_MAX_TTL_MS
  ) {
    throw new ClientWriteContextError(
      "expired",
      "Client write context is expired",
    );
  }
  const expectedSignature =
    await options.verifySignature(
      signedPayload(context),
    );
  if (
    !constantTimeEqual(
      expectedSignature,
      context.signature,
    )
  ) {
    throw invalid(
      "Client write context signature is invalid",
    );
  }

  const objects = new Map<
    string,
    StoredObject | null
  >();
  const headBytes = encodeJson(
    context.head.value as unknown as JsonValue,
  );
  objects.set(
    trieHeadKey(collection),
    context.head.etag === null
      ? null
      : {
          etag: context.head.etag,
          bytes: headBytes,
        },
  );
  let decodedBytes = headBytes.byteLength;
  if (
    decodedBytes >
    CLIENT_WRITE_CONTEXT_MAX_DECODED_BYTES
  ) {
    throw invalid(
      "Client write context exceeds the decoded-byte limit",
    );
  }
  if (
    context.objects.length >
    CLIENT_WRITE_CONTEXT_MAX_OBJECTS
  ) {
    throw invalid(
      "Client write context contains too many objects",
    );
  }
  for (const candidate of context.objects) {
    if (objects.has(candidate.key)) {
      throw invalid(
        `Client write context contains duplicate object ${candidate.key}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeJson(candidate.value);
    } catch {
      throw invalid(
        `Client write context object is not JSON: ${candidate.key}`,
      );
    }
    decodedBytes += bytes.byteLength;
    if (
      decodedBytes >
      CLIENT_WRITE_CONTEXT_MAX_DECODED_BYTES
    ) {
      throw invalid(
        "Client write context exceeds the decoded-byte limit",
      );
    }
    try {
      await requireContentAddress(
        collection,
        candidate.key,
        candidate.value,
        bytes,
        options.addressNode,
      );
    } catch (error) {
      if (error instanceof ClientWriteContextError) {
        throw error;
      }
      throw invalid(
        `Client write context object is malformed: ${candidate.key}`,
      );
    }
    objects.set(candidate.key, {
      etag: candidate.key,
      bytes,
    });
  }
  return {
    headEtag: context.head.etag,
    objects,
    verifiedObjects: context.objects.length + 1,
    verifiedDecodedBytes: decodedBytes,
  };
}

function parseContext(
  value: unknown,
): ClientTrieWriteContext {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalid("Client write context is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.scopeId !== "string" ||
    typeof record.collection !== "string" ||
    typeof record.layoutGeneration !== "string" ||
    record.layoutGeneration.length === 0 ||
    !Number.isInteger(record.issuedAt) ||
    !Number.isInteger(record.expiresAt) ||
    typeof record.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.signature) ||
    !Array.isArray(record.objects)
  ) {
    throw invalid("Client write context is malformed");
  }
  const head = parseHead(record.head);
  const objects = record.objects.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw invalid(
        "Client write context object is malformed",
      );
    }
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.key !== "string" ||
      !("value" in item)
    ) {
      throw invalid(
        "Client write context object is malformed",
      );
    }
    return {
      key: item.key,
      value: item.value as JsonValue,
    };
  });
  return {
    version: 1,
    scopeId: record.scopeId,
    collection: record.collection,
    layoutGeneration: record.layoutGeneration,
    issuedAt: record.issuedAt as number,
    expiresAt: record.expiresAt as number,
    head,
    objects,
    signature: record.signature,
  };
}

function parseHead(value: unknown): {
  etag: string | null;
  value: TrieHead;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalid("Client write context HEAD is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    !(
      record.etag === null ||
      (typeof record.etag === "string" &&
        record.etag.length > 0)
    )
  ) {
    throw invalid("Client write context HEAD ETag is invalid");
  }
  return {
    etag: record.etag,
    value: parseTrieHead(record.value),
  };
}

function parseTrieHead(value: unknown): TrieHead {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalid("Client write context HEAD is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.revision) ||
    (record.revision as number) < 0 ||
    !(
      record.rootHash === null ||
      (typeof record.rootHash === "string" &&
        /^[a-f0-9]{64}$/.test(record.rootHash))
    )
  ) {
    throw invalid("Client write context HEAD is malformed");
  }
  const indexes = parseIndexReferences(record.indexes);
  return {
    revision: record.revision as number,
    rootHash: record.rootHash as string | null,
    ...(indexes ? { indexes } : {}),
  };
}

function parseIndexReferences(
  value: unknown,
): SecondaryIndexReferences | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalid(
      "Client write context index references are malformed",
    );
  }
  const references: SecondaryIndexReferences = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw invalid(
        "Client write context index references are malformed",
      );
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.hash) ||
      !Number.isInteger(record.entries) ||
      (record.entries as number) < 0 ||
      (record.decodedBytes !== undefined &&
        (!Number.isInteger(record.decodedBytes) ||
          (record.decodedBytes as number) < 0))
    ) {
      throw invalid(
        "Client write context index references are malformed",
      );
    }
    references[name] = {
      hash: record.hash,
      entries: record.entries as number,
      ...(record.decodedBytes !== undefined
        ? {
            decodedBytes:
              record.decodedBytes as number,
          }
        : {}),
    };
  }
  return references;
}

async function requireContentAddress(
  collection: string,
  key: string,
  value: JsonValue,
  bytes: Uint8Array,
  addressNode: (
    bytes: Uint8Array,
  ) => Promise<string> | string,
): Promise<void> {
  const hash = await addressNode(bytes);
  const nodePrefix =
    `content-trie/${collection}/nodes/`;
  if (key.startsWith(nodePrefix)) {
    if (key !== trieNodeKey(collection, hash)) {
      throw invalid(
        `Client write context node address is invalid: ${key}`,
      );
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !(
        value.kind === "root" ||
        value.kind === "branch" ||
        value.kind === "leaf"
      )
    ) {
      throw invalid(
        `Client write context node is malformed: ${key}`,
      );
    }
    return;
  }
  const indexPrefix =
    `content-trie/${collection}/indexes/`;
  if (!key.startsWith(indexPrefix)) {
    throw invalid(
      `Client write context object key is invalid: ${key}`,
    );
  }
  const relative = key.slice(indexPrefix.length);
  const separator = relative.indexOf("/");
  const name = relative.slice(0, separator);
  if (
    separator < 1 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
    key !== trieIndexKey(collection, name, hash)
  ) {
    throw invalid(
      `Client write context index address is invalid: ${key}`,
    );
  }
  const page = secondaryIndexPageFromJson(value);
  if (
    !constantTimeEqual(
      bytesToHex(encodeSecondaryIndexPage(page)),
      bytesToHex(bytes),
    )
  ) {
    throw invalid(
      `Client write context index encoding is invalid: ${key}`,
    );
  }
}

function signedPayload(
  context: UnsignedClientTrieWriteContext,
): Uint8Array {
  return encodeJson({
    version: context.version,
    scopeId: context.scopeId,
    collection: context.collection,
    layoutGeneration: context.layoutGeneration,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    head: context.head as unknown as JsonValue,
  });
}

class ClientContextObjectStore implements ObjectStore {
  contextHits = 0;
  authoritativeReads = 0;

  constructor(
    private readonly delegate: ObjectStore,
    private readonly objects: ReadonlyMap<
      string,
      StoredObject | null
    >,
  ) {}

  get(key: string): Promise<StoredObject | null> {
    if (this.objects.has(key)) {
      this.contextHits += 1;
      const object = this.objects.get(key) ?? null;
      return Promise.resolve(
        object
          ? {
              etag: object.etag,
              bytes: object.bytes.slice(),
            }
          : null,
      );
    }
    this.authoritativeReads += 1;
    return this.delegate.get(key);
  }

  put(
    key: string,
    bytes: Uint8Array,
    conditions?: PutConditions,
  ): Promise<{ etag: string }> {
    return this.delegate.put(key, bytes, conditions);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.delegate.list(prefix);
  }
}

function fallbackResult(
  reason: ClientAssistedTrieWriteResult["fallbackReason"],
): ClientAssistedTrieWriteResult {
  return {
    mode: "fallback",
    fallbackReason: reason,
    contextHits: 0,
    authoritativeReadsDuringAttempt: 0,
    verifiedObjects: 0,
    verifiedDecodedBytes: 0,
    verificationMs: 0,
  };
}

function invalid(message: string): ClientWriteContextError {
  return new ClientWriteContextError("invalid", message);
}

function constantTimeEqual(
  left: string,
  right: string,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |=
      left.charCodeAt(index) ^
      right.charCodeAt(index);
  }
  return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) =>
      value.toString(16).padStart(2, "0"),
    )
    .join("");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
