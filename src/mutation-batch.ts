import type {
  JsonDocument,
} from "./core.js";
import type {
  CollectionLayout,
} from "./snapshot-protocol.js";
import type {
  TrieBundleObject,
} from "./trie-protocol.js";

export const MUTATION_BATCH_MAX_DOCUMENTS = 20;
export const MUTATION_BATCH_MAX_REQUEST_BYTES =
  1024 * 1024;
export const MUTATION_BATCH_MAX_RESPONSE_OBJECTS =
  2 + MUTATION_BATCH_MAX_DOCUMENTS * 2;
export const MUTATION_BATCH_MAX_RESPONSE_DECODED_BYTES =
  16 * 1024 * 1024;

export type MutationBatchRequest = {
  version: 1;
  documents: JsonDocument[];
};

export type MutationBatchBundle = {
  version: 1;
  collection: string;
  revision: number;
  documents: JsonDocument[];
  objects: TrieBundleObject[];
  layout: CollectionLayout;
  cacheComplete: boolean;
};

export class MutationBatchRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code:
      | "invalid_mutation_batch"
      | "mutation_batch_too_large",
    message: string,
  ) {
    super(message);
    this.name = "MutationBatchRequestError";
  }
}

export function mutationBatchDocuments(
  value: unknown,
): JsonDocument[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray(
      (value as { documents?: unknown }).documents,
    )
  ) {
    throw new MutationBatchRequestError(
      400,
      "invalid_mutation_batch",
      "Mutation batch must contain version 1 and a documents array",
    );
  }
  const documents = (
    value as { documents: unknown[] }
  ).documents;
  if (documents.length === 0) {
    throw new MutationBatchRequestError(
      400,
      "invalid_mutation_batch",
      "Mutation batch must contain at least one document",
    );
  }
  if (
    documents.length >
    MUTATION_BATCH_MAX_DOCUMENTS
  ) {
    throw new MutationBatchRequestError(
      413,
      "mutation_batch_too_large",
      `Mutation batch exceeds ${MUTATION_BATCH_MAX_DOCUMENTS} documents`,
    );
  }

  const ids = new Set<string>();
  const parsed: JsonDocument[] = [];
  for (const value of documents) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !==
        "string" ||
      (value as { id: string }).id.length === 0 ||
      "__thimbleTombstone" in value
    ) {
      throw new MutationBatchRequestError(
        400,
        "invalid_mutation_batch",
        "Every mutation batch document must have a string id",
      );
    }
    const document = value as JsonDocument;
    if (ids.has(document.id)) {
      throw new MutationBatchRequestError(
        400,
        "invalid_mutation_batch",
        `Mutation batch contains duplicate document id ${document.id}`,
      );
    }
    ids.add(document.id);
    parsed.push(document);
  }
  return parsed;
}

export function mutationBatchBundleFromJson(
  value: unknown,
): MutationBatchBundle {
  const record =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !record ||
    record.version !== 1 ||
    typeof record.collection !== "string" ||
    !Number.isInteger(record.revision) ||
    (record.revision as number) < 0 ||
    !Array.isArray(record.documents) ||
    !record.documents.every(isJsonDocument) ||
    !Array.isArray(record.objects) ||
    !record.objects.every(isBundleObject) ||
    !record.objects.some(
      (object) =>
        typeof object === "object" &&
        object !== null &&
        "key" in object &&
        typeof object.key === "string" &&
        object.key.endsWith("/HEAD.json"),
    ) ||
    (record.layout !== "snapshot" &&
      record.layout !== "trie") ||
    typeof record.cacheComplete !== "boolean"
  ) {
    throw new Error(
      "Mutation batch response is malformed",
    );
  }
  return value as MutationBatchBundle;
}

function isJsonDocument(
  value: unknown,
): value is JsonDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id ===
      "string"
  );
}

function isBundleObject(
  value: unknown,
): value is TrieBundleObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { key?: unknown }).key ===
      "string" &&
    typeof (value as { etag?: unknown }).etag ===
      "string" &&
    "value" in value
  );
}
