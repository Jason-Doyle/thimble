import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateSecret } from "../src/server-keys.js";

describe("local server secrets", () => {
  const originalRoot = process.env.THIMBLE_LOCAL_SECRET_ROOT;
  const originalSecret = process.env.TEST_THIMBLE_SECRET;

  afterEach(() => {
    restore("THIMBLE_LOCAL_SECRET_ROOT", originalRoot);
    restore("TEST_THIMBLE_SECRET", originalSecret);
  });

  it("rejects undersized persisted secrets", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-secret-"),
    );
    try {
      process.env.THIMBLE_LOCAL_SECRET_ROOT = directory;
      delete process.env.TEST_THIMBLE_SECRET;
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "test.key"),
        `${Buffer.alloc(8).toString("base64")}\n`,
      );

      await expect(
        loadOrCreateSecret(
          "TEST_THIMBLE_SECRET",
          "test.key",
          true,
          32,
        ),
      ).rejects.toThrow("invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns one valid secret during concurrent first use", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-secret-race-"),
    );
    try {
      process.env.THIMBLE_LOCAL_SECRET_ROOT = directory;
      delete process.env.TEST_THIMBLE_SECRET;
      const [first, second] = await Promise.all([
        loadOrCreateSecret(
          "TEST_THIMBLE_SECRET",
          "test.key",
          true,
          32,
        ),
        loadOrCreateSecret(
          "TEST_THIMBLE_SECRET",
          "test.key",
          true,
          32,
        ),
      ]);

      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
