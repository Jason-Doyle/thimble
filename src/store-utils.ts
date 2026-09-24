import { PreconditionFailedError } from "./core.js";

export function normalizeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Invalid object key: ${key}`);
  }
  return normalized;
}

export function mapPreconditionError(
  error: unknown,
  key: string,
): Error {
  const status = httpStatus(error);
  if (status === 409 || status === 412) {
    return new PreconditionFailedError(
      `Conditional object write failed for ${key}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
  ) {
    return error.$metadata.httpStatusCode;
  }
  return undefined;
}

export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
