import { describe, expect, it } from "vitest";
import {
  parseProvider,
} from "../src/providers/configured.js";
import { AzureBlobObjectStore } from "../src/providers/azure.js";
import { LocalObjectStore } from "../src/providers/local.js";
import { S3ObjectStore } from "../src/providers/s3.js";

describe("provider adapters", () => {
  it("exports each provider independently", () => {
    expect(LocalObjectStore).toBeTypeOf("function");
    expect(AzureBlobObjectStore).toBeTypeOf("function");
    expect(S3ObjectStore).toBeTypeOf("function");
  });

  it.each(["local", "azure", "s3", "r2"] as const)(
    "accepts the %s provider",
    (provider) => {
      expect(parseProvider(provider)).toBe(provider);
    },
  );

  it("rejects unsupported providers", () => {
    expect(() => parseProvider("other")).toThrow(
      "Unsupported THIMBLE_PROVIDER: other",
    );
  });
});
