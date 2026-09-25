import type {
  JsonDocument,
  JsonPrimitive,
  JsonValue,
} from "./core.js";
import type {
  QueryComparison,
  QueryExpression,
  ThimbleQuery,
} from "./query.js";
import {
  createDictionary,
  encodeJson,
  validateName,
} from "./shared-utils.js";
import {
  isTrieTombstone,
  type TrieStoredDocument,
} from "./trie-protocol.js";

export type SecondaryIndexMode = "equality" | "range";
export const MAX_COVERING_FIELDS = 8;
export const MAX_COVERING_DOCUMENT_BYTES = 64 * 1024;
export const MAX_SECONDARY_INDEX_PAGE_BYTES =
  4 * 1024 * 1024;

export class SecondaryIndexLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecondaryIndexLimitError";
  }
}

export function validateProjectionFields(
  fields: string[],
): string[] {
  if (
    fields.length < 1 ||
    fields.length > MAX_COVERING_FIELDS ||
    new Set(fields).size !== fields.length ||
    !fields.every(
      (field) => isIndexFieldName(field) && field !== "id",
    )
  ) {
    throw new Error(
      "Query projection requires 1-8 unique safe non-ID fields",
    );
  }
  return [...fields];
}

export type SecondaryIndexDefinition = {
  name: string;
  fields: string[];
  mode: SecondaryIndexMode;
  include?: string[];
};

export function defineIndex<T extends { id: string }>(
  name: string,
  fields: Array<Extract<keyof T, string>>,
  mode: SecondaryIndexMode = "equality",
  options: {
    include?: Array<Extract<keyof T, string>>;
  } = {},
): SecondaryIndexDefinition {
  const configuration = validateIndexConfiguration({
    collection: [
      {
        name,
        fields,
        mode,
        ...(options.include
          ? { include: options.include }
          : {}),
      },
    ],
  });
  return configuration.collection![0]!;
}

export type CollectionIndexConfiguration = Record<
  string,
  SecondaryIndexDefinition[]
>;

export type SecondaryIndexReference = {
  hash: string;
  entries: number;
  decodedBytes?: number;
};

export type SecondaryIndexReferences = Record<
  string,
  SecondaryIndexReference
>;

export type SecondaryIndexEntry = {
  values: JsonPrimitive[];
  ids: string[];
};

export type SecondaryIndexPage = {
  version: 1;
  definition: SecondaryIndexDefinition;
  entries: SecondaryIndexEntry[];
  projections?: Record<string, JsonDocument>;
};

export type SecondaryIndexChange = {
  id: string;
  document: TrieStoredDocument | null;
};

export type SecondaryIndexPlan<T extends { id: string }> = {
  definition: SecondaryIndexDefinition;
  comparisons: QueryComparison<T>[];
};

export function validateIndexConfiguration(
  configuration: CollectionIndexConfiguration,
): CollectionIndexConfiguration {
  const normalized =
    createDictionary<SecondaryIndexDefinition[]>();
  for (const [collection, definitions] of Object.entries(configuration)) {
    if (!Array.isArray(definitions)) {
      throw new Error("Collection index configuration is malformed");
    }
    const normalizedCollection = validateName(
      collection,
      "Collection",
    );
    const names = new Set<string>();
    normalized[normalizedCollection] = definitions.map((definition) => {
      if (
        !definition ||
        typeof definition.name !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(definition.name) ||
        names.has(definition.name) ||
        !Array.isArray(definition.fields) ||
        definition.fields.length < 1 ||
        definition.fields.length > 4 ||
        new Set(definition.fields).size !==
          definition.fields.length ||
        !definition.fields.every(isIndexFieldName) ||
        (definition.mode !== "equality" &&
          definition.mode !== "range") ||
        (definition.mode === "range" &&
          definition.fields.length !== 1) ||
        (definition.include !== undefined &&
          (!Array.isArray(definition.include) ||
            definition.include.length < 1 ||
            definition.include.length > MAX_COVERING_FIELDS ||
            new Set(definition.include).size !==
              definition.include.length ||
            !definition.include.every(
              (field) =>
                isIndexFieldName(field) &&
                field !== "id" &&
                !definition.fields.includes(field),
            )))
      ) {
        throw new Error(
          `Invalid secondary index configuration for ${collection}`,
        );
      }
      names.add(definition.name);
      return {
        name: definition.name,
        fields: [...definition.fields],
        mode: definition.mode,
        ...(definition.include
          ? { include: [...definition.include] }
          : {}),
      };
    });
  }
  return normalized;
}

export function parseIndexConfiguration(
  configured: string | undefined,
): CollectionIndexConfiguration {
  if (!configured?.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch (error) {
    throw new Error(
      "THIMBLE_COLLECTION_INDEXES must be valid JSON",
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "THIMBLE_COLLECTION_INDEXES must be an object",
    );
  }
  return validateIndexConfiguration(
    parsed as CollectionIndexConfiguration,
  );
}

export function buildSecondaryIndexPage(
  definition: SecondaryIndexDefinition,
  documents: Iterable<TrieStoredDocument>,
): SecondaryIndexPage {
  const entries = new Map<string, SecondaryIndexEntry>();
  const projections = definition.include
    ? createDictionary<JsonDocument>()
    : undefined;
  for (const stored of documents) {
    if (isTrieTombstone(stored)) {
      continue;
    }
    addDocument(entries, projections, definition, stored);
  }
  return {
    version: 1,
    definition,
    entries: sortEntries([...entries.values()]),
    ...(projections ? { projections } : {}),
  };
}

export function updateSecondaryIndexPage(
  current: SecondaryIndexPage | null,
  definition: SecondaryIndexDefinition,
  changes: SecondaryIndexChange[],
): SecondaryIndexPage {
  const entries = new Map<string, SecondaryIndexEntry>();
  const projections = definition.include
    ? createDictionary<JsonDocument>(
        current?.projections,
      )
    : undefined;
  for (const entry of current?.entries ?? []) {
    entries.set(indexKey(entry.values), {
      values: [...entry.values],
      ids: [...entry.ids],
    });
  }
  const changedIds = new Set(changes.map((change) => change.id));
  for (const [key, entry] of entries) {
    entry.ids = entry.ids.filter((id) => !changedIds.has(id));
    if (entry.ids.length === 0) {
      entries.delete(key);
    }
  }
  for (const change of changes) {
    if (projections) {
      delete projections[change.id];
    }
    if (change.document && !isTrieTombstone(change.document)) {
      addDocument(
        entries,
        projections,
        definition,
        change.document,
      );
    }
  }
  return {
    version: 1,
    definition,
    entries: sortEntries([...entries.values()]),
    ...(projections ? { projections } : {}),
  };
}

export function planSecondaryIndex<T extends { id: string }>(
  definitions: SecondaryIndexDefinition[],
  query: ThimbleQuery<T>,
): SecondaryIndexPlan<T> | null {
  const comparisons = flattenComparisons(query.where);
  if (!comparisons) {
    return null;
  }
  for (const definition of definitions) {
    if (definition.mode === "equality") {
      const matched = definition.fields.map((field) =>
        comparisons.find(
          (comparison) =>
            comparison.field === field &&
            comparison.operator === "eq" &&
            isJsonPrimitive(comparison.value),
        ),
      );
      if (matched.every(Boolean)) {
        return {
          definition,
          comparisons: matched as QueryComparison<T>[],
        };
      }
      continue;
    }
    const comparison = comparisons.find(
      (candidate) =>
        candidate.field === definition.fields[0] &&
        ["eq", "lt", "lte", "gt", "gte"].includes(
          candidate.operator,
        ) &&
        isJsonPrimitive(candidate.value),
    );
    if (comparison) {
      return {
        definition,
        comparisons: [comparison],
      };
    }
  }
  return null;
}

export function idsFromSecondaryIndex<T extends { id: string }>(
  page: SecondaryIndexPage,
  plan: SecondaryIndexPlan<T>,
): string[] {
  if (
    !secondaryIndexDefinitionsEqual(
      page.definition,
      plan.definition,
    )
  ) {
    throw new Error("Secondary index page does not match query plan");
  }
  if (plan.definition.mode === "equality") {
    const values = plan.definition.fields.map((field) => {
      const comparison = plan.comparisons.find(
        (candidate) => candidate.field === field,
      );
      return comparison?.value;
    });
    if (!values.every(isJsonPrimitive)) {
      return [];
    }
    const key = indexKey(values as JsonPrimitive[]);
    return (
      page.entries.find((entry) => indexKey(entry.values) === key)
        ?.ids ?? []
    );
  }
  const comparison = plan.comparisons[0]!;
  if (!isJsonPrimitive(comparison.value)) {
    return [];
  }
  return page.entries
    .filter((entry) =>
      compareIndexedValue(
        entry.values[0],
        comparison.operator,
        comparison.value as JsonPrimitive,
      ),
    )
    .flatMap((entry) => entry.ids);
}

export function secondaryIndexPageFromJson(
  value: JsonValue,
): SecondaryIndexPage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.version !== 1 ||
    typeof value.definition !== "object" ||
    value.definition === null ||
    Array.isArray(value.definition) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Secondary index page is malformed");
  }
  const definition = validateIndexConfiguration({
    collection: [
      value.definition as unknown as SecondaryIndexDefinition,
    ],
  }).collection![0]!;
  const keys = new Set<string>();
  const documentIds = new Set<string>();
  const indexedValues = new Map<string, JsonPrimitive[]>();
  const entries = value.entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !Array.isArray(entry.values) ||
      entry.values.length !== definition.fields.length ||
      !entry.values.every(isJsonPrimitive) ||
      !Array.isArray(entry.ids) ||
      !entry.ids.every(
        (id) => typeof id === "string" && id.length > 0,
      ) ||
      new Set(entry.ids).size !== entry.ids.length
    ) {
      throw new Error("Secondary index page is malformed");
    }
    const values = [...entry.values] as JsonPrimitive[];
    const ids = [...entry.ids] as string[];
    const key = indexKey(values);
    if (keys.has(key)) {
      throw new Error("Secondary index page contains duplicate values");
    }
    keys.add(key);
    for (const id of ids) {
      if (documentIds.has(id)) {
        throw new Error(
          "Secondary index page contains a duplicate document",
        );
      }
      documentIds.add(id);
      indexedValues.set(id, values);
    }
    return {
      values,
      ids,
    };
  });
  const projections = parseProjections(
    value.projections,
    definition,
    documentIds,
    indexedValues,
  );
  return {
    version: 1,
    definition,
    entries,
    ...(projections ? { projections } : {}),
  };
}

export function secondaryIndexDefinitionsEqual(
  left: SecondaryIndexDefinition,
  right: SecondaryIndexDefinition,
): boolean {
  return (
    left.name === right.name &&
    left.mode === right.mode &&
    left.fields.length === right.fields.length &&
    left.fields.every(
      (field, index) => field === right.fields[index],
    ) &&
    (left.include?.length ?? 0) ===
      (right.include?.length ?? 0) &&
    (left.include ?? []).every(
      (field, index) => field === right.include?.[index],
    )
  );
}

function addDocument(
  entries: Map<string, SecondaryIndexEntry>,
  projections: Record<string, JsonDocument> | undefined,
  definition: SecondaryIndexDefinition,
  document: JsonDocument,
): void {
  const values = definition.fields.map((field) => document[field]);
  if (!values.every(isJsonPrimitive)) {
    return;
  }
  const primitives = values as JsonPrimitive[];
  const key = indexKey(primitives);
  const entry = entries.get(key) ?? {
    values: primitives,
    ids: [],
  };
  if (!entry.ids.includes(document.id)) {
    entry.ids.push(document.id);
    entry.ids.sort();
  }
  entries.set(key, entry);
  if (projections) {
    projections[document.id] = projectIndexDocument(
      definition,
      document,
    );
  }
}

export function documentsFromCoveringIndex<
  T extends { id: string },
>(
  page: SecondaryIndexPage,
  plan: SecondaryIndexPlan<T>,
  requiredFields: Iterable<string>,
): JsonDocument[] | null {
  if (!page.projections) {
    return null;
  }
  const covered = new Set([
    "id",
    ...page.definition.fields,
    ...(page.definition.include ?? []),
  ]);
  if (
    [...requiredFields].some((field) => !covered.has(field))
  ) {
    return null;
  }
  const ids = idsFromSecondaryIndex(page, plan);
  const documents: JsonDocument[] = [];
  for (const id of ids) {
    const projection = page.projections[id];
    if (!projection) {
      throw new Error(
        `Secondary index projection is missing document ${id}`,
      );
    }
    documents.push(structuredClone(projection));
  }
  return documents;
}

function projectIndexDocument(
  definition: SecondaryIndexDefinition,
  document: JsonDocument,
): JsonDocument {
  const projection: JsonDocument = { id: document.id };
  for (const field of [
    ...definition.fields,
    ...(definition.include ?? []),
  ]) {
    if (document[field] !== undefined) {
      projection[field] = structuredClone(document[field]);
    }
  }
  if (
    encodeJson(projection as unknown as JsonValue).byteLength >
    MAX_COVERING_DOCUMENT_BYTES
  ) {
    throw new SecondaryIndexLimitError(
      `Secondary index covering projection exceeds ${MAX_COVERING_DOCUMENT_BYTES} decoded bytes for ${document.id}`,
    );
  }

  return projection;
}

export function encodeSecondaryIndexPage(
  page: SecondaryIndexPage,
): Uint8Array {
  const bytes = encodeJson(page as unknown as JsonValue);
  if (bytes.byteLength > MAX_SECONDARY_INDEX_PAGE_BYTES) {
    throw new SecondaryIndexLimitError(
      `Secondary index ${page.definition.name} exceeds ${MAX_SECONDARY_INDEX_PAGE_BYTES} decoded bytes`,
    );
  }
  return bytes;
}

function isIndexFieldName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value) &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor"
  );
}

function parseProjections(
  value: unknown,
  definition: SecondaryIndexDefinition,
  documentIds: Set<string>,
  indexedValues: Map<string, JsonPrimitive[]>,
): Record<string, JsonDocument> | undefined {
  if (!definition.include) {
    if (value !== undefined) {
      throw new Error(
        "Secondary index page has undeclared projections",
      );
    }
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Secondary index page is missing covering projections",
    );
  }
  const allowedFields = new Set([
    "id",
    ...definition.fields,
    ...definition.include,
  ]);
  const projections = createDictionary<JsonDocument>();
  for (const [id, candidate] of Object.entries(value)) {
    if (
      !documentIds.has(id) ||
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      candidate.id !== id ||
      Object.keys(candidate).some(
        (field) => !allowedFields.has(field),
      )
    ) {
      throw new Error(
        "Secondary index covering projection is malformed",
      );
    }
    const projection = candidate as JsonDocument;
    const values = indexedValues.get(id)!;
    for (let index = 0; index < definition.fields.length; index += 1) {
      if (
        projection[definition.fields[index]!] !== values[index]
      ) {
        throw new Error(
          "Secondary index covering projection does not match its key",
        );
      }
    }
    projections[id] = structuredClone(projection);
  }
  if (Object.keys(projections).length !== documentIds.size) {
    throw new Error(
      "Secondary index page is missing covering projections",
    );
  }
  return projections;
}

function flattenComparisons<T extends { id: string }>(
  expression: QueryExpression<T> | undefined,
): QueryComparison<T>[] | null {
  if (!expression) {
    return [];
  }
  if ("field" in expression) {
    return [expression];
  }
  if ("and" in expression) {
    const flattened = expression.and.map(flattenComparisons);
    return flattened.some((items) => items === null)
      ? null
      : flattened.flatMap((items) => items ?? []);
  }
  return null;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function indexKey(values: JsonPrimitive[]): string {
  return JSON.stringify(values);
}

function sortEntries(
  entries: SecondaryIndexEntry[],
): SecondaryIndexEntry[] {
  return entries.sort((left, right) =>
    compareTuples(left.values, right.values),
  );
}

function compareTuples(
  left: JsonPrimitive[],
  right: JsonPrimitive[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = comparePrimitive(left[index], right[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function comparePrimitive(
  left: JsonPrimitive | undefined,
  right: JsonPrimitive | undefined,
): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return -1;
  }
  if (right === undefined) {
    return 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function compareIndexedValue(
  actual: JsonPrimitive | undefined,
  operator: QueryComparison<JsonDocument>["operator"],
  expected: JsonPrimitive,
): boolean {
  const comparison = comparePrimitive(actual, expected);
  if (operator === "eq") {
    return comparison === 0;
  }
  if (operator === "lt") {
    return comparison < 0;
  }
  if (operator === "lte") {
    return comparison <= 0;
  }
  if (operator === "gt") {
    return comparison > 0;
  }
  if (operator === "gte") {
    return comparison >= 0;
  }
  return false;
}
