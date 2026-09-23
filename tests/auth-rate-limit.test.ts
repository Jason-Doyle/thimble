import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectStoreAuthRateLimiter } from "../src/auth/rate-limit.js";
import { LocalObjectStore } from "../src/stores.js";

describe("ObjectStoreAuthRateLimiter", () => {
  it("enforces one shared limit under concurrent attempts", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-rate-limit-"),
    );
    try {
      const limiter = new ObjectStoreAuthRateLimiter(
        new LocalObjectStore(directory),
        (value) =>
          createHash("sha256").update(value).digest("hex"),
        3,
        60_000,
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, () => limiter.consume("account")),
      );

      expect(results.filter((result) => result.allowed)).toHaveLength(3);
      expect(
        results.filter((result) => !result.allowed),
      ).toHaveLength(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
