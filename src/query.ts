import type {
  JsonDocument,
  JsonValue,
} from "./core.js";
import { stableStringify } from "./shared-utils.js";

export type QueryField<T extends { id: string }> =
  Extract<keyof T, string>;

export type QueryComparison<T extends { id: string }> = {
  field: QueryField<T>;
  operator:
    | "eq"
    | "ne"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "in"
    | "contains";
  value: JsonValue;
};

export type QueryExpression<T extends { id: string }> =
  | QueryComparison<T>
  | {
      and: QueryExpression<T>[];
    }
  | {
      or: QueryExpression<T>[];
    }
  | {
      not: QueryExpression<T>;
    };

export type QueryOrder<T extends { id: string }> = {
  field: QueryField<T>;
  direction?: "asc" | "desc";
};

export type ThimbleQuery<T extends { id: string }> = {
  version: 1;
  where?: QueryExpression<T>;
  orderBy?: QueryOrder<T>[];
  limit?: number;
  maxScanDocuments?: number;
};

export type ThimbleQueryResult<T extends { id: string }> = {
  documents: T[];
  plan: "point" | "index" | "scan";
  indexName: string | null;
  scannedDocuments: number;
};

export function evaluateThimbleQuery<T extends { id: string }>(
  documents: T[],
  query: ThimbleQuery<T>,
): ThimbleQueryResult<T> {
  validateThimbleQuery(query);
  const maxScanDocuments = query.maxScanDocuments ?? 1_000;
  if (documents.length > maxScanDocuments) {
    throw new Error(
      `Query scan contains ${documents.length} documents, above the configured maximum of ${maxScanDocuments}`,
    );
  }
  const filtered = query.where
    ? documents.filter((document) =>
        evaluateExpression(document, query.where!),
      )
    : [...documents];
  const ordered = orderDocuments(filtered, query.orderBy ?? []);
  return {
    documents: ordered.slice(0, query.limit ?? 100),
    plan: "scan",
    indexName: null,
    scannedDocuments: documents.length,
  };
}

export function pointReadId<T extends { id: string }>(
  query: ThimbleQuery<T>,
): string | null {
  const where = query.where;
  if (
    where &&
    "field" in where &&
    where.field === "id" &&
    where.operator === "eq" &&
    typeof where.value === "string"
  ) {
    return where.value;
  }

  return null;
}

export function queryFieldNames<T extends { id: string }>(
  query: ThimbleQuery<T>,
): string[] {
  const fields = new Set<string>();
  collectExpressionFields(query.where, fields);
  for (const order of query.orderBy ?? []) {
    fields.add(order.field);
  }
  return [...fields];
}

export function validateThimbleQuery<T extends { id: string }>(
  query: ThimbleQuery<T>,
): void {
  if (
    typeof query !== "object" ||
    query === null ||
    Array.isArray(query)
  ) {
    throw new Error("Query must be an object");
  }
  if (query.version !== 1) {
    throw new Error(`Unsupported query version: ${String(query.version)}`);
  }
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Query limit must be an integer between 1 and 1000");
  }
  const maxScanDocuments = query.maxScanDocuments ?? 1_000;
  if (
    !Number.isInteger(maxScanDocuments) ||
    maxScanDocuments < 1 ||
    maxScanDocuments > 100_000
  ) {
    throw new Error(
      "Query maxScanDocuments must be an integer between 1 and 100000",
    );
  }
  if (query.orderBy !== undefined) {
    if (!Array.isArray(query.orderBy)) {
      throw new Error("Query orderBy must be an array");
    }
    if (query.orderBy.length > 4) {
      throw new Error("A query can order by at most four fields");
    }
    for (const order of query.orderBy) {
      if (
        !isRecord(order) ||
        typeof order.field !== "string" ||
        order.field.length === 0 ||
        (order.direction !== undefined &&
          order.direction !== "asc" &&
          order.direction !== "desc")
      ) {
        throw new Error("Query ordering is malformed");
      }
    }
  }
  if (query.where !== undefined) {
    validateExpression(query.where, 0, { nodes: 0 });
  }
}

function validateExpression(
  expression: unknown,
  depth: number,
  state: { nodes: number },
): void {
  if (depth > 12) {
    throw new Error("Query expression nesting exceeds 12 levels");
  }

  state.nodes += 1;
  if (state.nodes > 500) {
    throw new Error("Query expression exceeds 500 nodes");
  }

  if (!isRecord(expression)) {
    throw new Error("Query expression is malformed");
  }
  const hasField = Object.hasOwn(expression, "field");
  const hasAnd = Object.hasOwn(expression, "and");
  const hasOr = Object.hasOwn(expression, "or");
  const hasNot = Object.hasOwn(expression, "not");
  if (
    Number(hasField) +
      Number(hasAnd) +
      Number(hasOr) +
      Number(hasNot) !==
    1
  ) {
    throw new Error("Query expression is malformed");
  }
  if (hasField) {
    if (
      typeof expression.field !== "string" ||
      expression.field.length === 0 ||
      !isQueryOperator(expression.operator) ||
      !Object.hasOwn(expression, "value") ||
      !isJsonValue(expression.value)
    ) {
      throw new Error("Query comparison is malformed");
    }
    if (
      expression.operator === "in" &&
      (!Array.isArray(expression.value) ||
        expression.value.length === 0 ||
        expression.value.length > 100)
    ) {
      throw new Error(
        "Query in operator requires between 1 and 100 values",
      );
    }
    if (
      ["lt", "lte", "gt", "gte"].includes(
        expression.operator,
      ) &&
      typeof expression.value !== "string" &&
      typeof expression.value !== "number"
    ) {
      throw new Error(
        "Ordered query comparisons require a string or number",
      );
    }
    return;
  }
  if (hasAnd || hasOr) {
    const children =
      hasAnd ? expression.and : expression.or;
    if (
      !Array.isArray(children) ||
      children.length === 0 ||
      children.length > 50
    ) {
      throw new Error(
        "Query boolean groups require between 1 and 50 expressions",
      );
    }
    children.forEach((child) =>
      validateExpression(child, depth + 1, state),
    );
    return;
  }
  validateExpression(expression.not, depth + 1, state);
}

function collectExpressionFields<T extends { id: string }>(
  expression: QueryExpression<T> | undefined,
  fields: Set<string>,
): void {
  if (!expression) {
    return;
  }
  if ("field" in expression) {
    fields.add(expression.field);
    return;
  }
  if ("and" in expression) {
    expression.and.forEach((child) =>
      collectExpressionFields(child, fields),
    );
    return;
  }
  if ("or" in expression) {
    expression.or.forEach((child) =>
      collectExpressionFields(child, fields),
    );
    return;
  }
  collectExpressionFields(expression.not, fields);
}

function evaluateExpression<T extends { id: string }>(
  document: T,
  expression: QueryExpression<T>,
): boolean {
  if ("field" in expression) {
    return compare(
      (document as Record<string, unknown>)[
        expression.field
      ] as JsonValue | undefined,
      expression.operator,
      expression.value,
    );
  }
  if ("and" in expression) {
    return expression.and.every((child) =>
      evaluateExpression(document, child),
    );
  }
  if ("or" in expression) {
    return expression.or.some((child) =>
      evaluateExpression(document, child),
    );
  }
  return !evaluateExpression(document, expression.not);
}

function compare(
  actual: JsonValue | undefined,
  operator: QueryComparison<JsonDocument>["operator"],
  expected: JsonValue,
): boolean {
  if (operator === "eq") {
    return equalJson(actual, expected);
  }
  if (operator === "ne") {
    return !equalJson(actual, expected);
  }
  if (operator === "in") {
    return (
      Array.isArray(expected) &&
      expected.some((candidate) => equalJson(actual, candidate))
    );
  }
  if (operator === "contains") {
    if (typeof actual === "string" && typeof expected === "string") {
      return actual.includes(expected);
    }
    if (Array.isArray(actual)) {
      return actual.some((candidate) => equalJson(candidate, expected));
    }
    return false;
  }
  if (
    (typeof actual !== "string" &&
      typeof actual !== "number") ||
    typeof actual !== typeof expected
  ) {
    return false;
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return orderedComparison(
      actual.localeCompare(expected),
      operator,
    );
  }
  if (typeof actual === "number" && typeof expected === "number") {
    return orderedComparison(actual - expected, operator);
  }
  return false;
}

function orderedComparison(
  comparison: number,
  operator: "lt" | "lte" | "gt" | "gte",
): boolean {
  if (operator === "lt") {
    return comparison < 0;
  }
  if (operator === "lte") {
    return comparison <= 0;
  }
  if (operator === "gt") {
    return comparison > 0;
  }
  return comparison >= 0;
}

function equalJson(
  left: JsonValue | undefined,
  right: JsonValue,
): boolean {
  if (left === undefined) {
    return false;
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return left === right;
  }
  return stableStringify(left) === stableStringify(right);
}

function orderDocuments<T extends { id: string }>(
  documents: T[],
  order: QueryOrder<T>[],
): T[] {
  const effectiveOrder =
    order.length > 0
      ? order
      : [{ field: "id", direction: "asc" } as QueryOrder<T>];
  return [...documents].sort((left, right) => {
    for (const item of effectiveOrder) {
      const comparison = compareValues(
        (left as Record<string, unknown>)[item.field] as
          | JsonValue
          | undefined,
        (right as Record<string, unknown>)[item.field] as
          | JsonValue
          | undefined,
      );
      if (comparison !== 0) {
        return item.direction === "desc"
          ? -comparison
          : comparison;
      }
    }
    return left.id.localeCompare(right.id);
  });
}

function compareValues(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
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
  return stableStringify(left).localeCompare(stableStringify(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isQueryOperator(
  value: unknown,
): value is QueryComparison<JsonDocument>["operator"] {
  return (
    value === "eq" ||
    value === "ne" ||
    value === "lt" ||
    value === "lte" ||
    value === "gt" ||
    value === "gte" ||
    value === "in" ||
    value === "contains"
  );
}

function isJsonValue(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
): value is JsonValue {
  if (depth > 20) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    const valid = value.every((item) =>
      isJsonValue(item, depth + 1, seen),
    );
    seen.delete(value);
    return valid;
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      seen.has(value)
    ) {
      return false;
    }
    seen.add(value);
    const valid = Object.values(value).every((item) =>
      isJsonValue(item, depth + 1, seen),
    );
    seen.delete(value);
    return valid;
  }
  return false;
}
