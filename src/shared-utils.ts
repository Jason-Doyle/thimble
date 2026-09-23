import type { JsonValue } from "./core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Unsupported JSON value");
    }
    return serialized;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${stableStringify(item as JsonValue)}`,
    )
    .join(",")}}`;
}

export function encodeJson(value: JsonValue): Uint8Array {
  return encoder.encode(stableStringify(value));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

export function validateName(value: string, label: string): string {
  if (
    value === "." ||
    value === ".." ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error(
      `${label} must be 1-128 letters, numbers, ".", "_" or "-", and cannot be "." or ".."`,
    );
  }
  return value;
}

export function isPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "PreconditionFailedError"
  );
}

export function createDictionary<T>(
  source?: Record<string, T>,
): Record<string, T> {
  return Object.assign(
    Object.create(null) as Record<string, T>,
    source,
  );
}

export function ownValue<T>(
  dictionary: Record<string, T>,
  key: string,
): T | undefined {
  return Object.hasOwn(dictionary, key)
    ? dictionary[key]
    : undefined;
}
