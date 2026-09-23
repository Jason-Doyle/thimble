import { createHash } from "node:crypto";
export {
  createDictionary,
  decodeJson,
  encodeJson,
  isPreconditionFailure,
  ownValue,
  stableStringify,
  validateName,
} from "./shared-utils.js";

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function percentile(values: number[], percentage: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
