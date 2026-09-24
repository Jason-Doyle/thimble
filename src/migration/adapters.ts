import type {
  JsonDocument,
  JsonValue,
} from "../core.js";

export function recordsFromJson(
  value: unknown,
  options: {
    path?: string;
    idField?: string;
  } = {},
): JsonDocument[] {
  const selected = options.path
    ? valueAtPath(value, options.path)
    : value;
  if (!Array.isArray(selected)) {
    throw new Error("JSON migration input must resolve to an array");
  }
  return selected.map((record, index) =>
    documentFromRecord(
      record,
      options.idField ?? "id",
      `JSON record ${index + 1}`,
    ),
  );
}

export function recordsFromLowdb(
  value: unknown,
  path: string,
  idField = "id",
): JsonDocument[] {
  if (!path.trim()) {
    throw new Error("lowdb migration requires a data path");
  }
  return recordsFromJson(value, { path, idField });
}

export function recordsFromCsv(
  input: string,
  idField = "id",
): JsonDocument[] {
  const rows = parseCsv(input);
  const headers = rows.shift();
  if (!headers || headers.length === 0) {
    throw new Error("CSV migration input requires a header row");
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV migration headers must be unique");
  }
  if (headers.some((header) => header.length === 0)) {
    throw new Error("CSV migration headers must not be empty");
  }
  return rows
    .filter((row) => row.some((value) => value.length > 0))
    .map((row, index) => {
      if (row.length > headers.length) {
        throw new Error(
          `CSV row ${index + 2} has more values than headers`,
        );
      }
      const record = Object.fromEntries(
        headers.map((header, column) => [
          header,
          row[column] ?? "",
        ]),
      );
      return documentFromRecord(
        record,
        idField,
        `CSV row ${index + 2}`,
      );
    });
}

export function recordsToJson(
  records: JsonDocument[],
): string {
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function recordsToCsv(
  records: JsonDocument[],
): string {
  const fields = [
    "id",
    ...new Set(
      records.flatMap((record) =>
        Object.keys(record).filter((field) => field !== "id"),
      ),
    ),
  ];
  return [
    fields.map(csvCell).join(","),
    ...records.map((record) =>
      fields
        .map((field) =>
          csvCell(csvValue(record[field])),
        )
        .join(","),
    ),
  ].join("\n") + "\n";
}

export function documentFromRecord(
  value: unknown,
  idField: string,
  source = "record",
): JsonDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${source} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const id = record[idField];
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    (typeof id === "number" && !Number.isFinite(id)) ||
    String(id).length === 0
  ) {
    throw new Error(
      `${source} is missing a string or number ${idField}`,
    );
  }
  if (
    idField !== "id" &&
    Object.hasOwn(record, "id") &&
    String(record.id) !== String(id)
  ) {
    throw new Error(
      `${source} contains an id that conflicts with ${idField}`,
    );
  }
  const document = Object.assign(
    Object.create(null) as Record<string, JsonValue>,
    { id: String(id) },
  );
  for (const [field, fieldValue] of Object.entries(record)) {
    if (field === idField || field === "id") {
      continue;
    }
    assertJsonValue(fieldValue, `${source}.${field}`);
    document[field] = fieldValue;
  }
  return document as JsonDocument;
}

function valueAtPath(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("JSON path is required");
  }
  return segments.reduce<unknown>((current, segment) => {
      if (
        typeof current !== "object" ||
        current === null ||
        Array.isArray(current) ||
        !Object.hasOwn(current, segment)
      ) {
        throw new Error(`JSON path does not exist: ${path}`);
      }
      return (current as Record<string, unknown>)[segment];
  }, value);
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen: Set<object> = new Set(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`${path} contains a circular value`);
    }
    seen.add(value);
    value.forEach((item, index) =>
      assertJsonValue(item, `${path}[${index}]`, seen),
    );
    seen.delete(value);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new Error(`${path} is not a plain JSON object`);
    }
    if (seen.has(value)) {
      throw new Error(`${path} contains a circular value`);
    }
    seen.add(value);
    Object.entries(value).forEach(([field, item]) =>
      assertJsonValue(item, `${path}.${field}`, seen),
    );
    seen.delete(value);
    return;
  }
  throw new Error(`${path} is not JSON-compatible`);
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) {
    throw new Error("CSV migration input has an unterminated quote");
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function csvValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "object"
    ? JSON.stringify(value)
    : String(value);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}
