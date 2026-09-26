import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import {
  importAesGcmKey,
  inspectEnvelope,
} from "../src/envelope.js";
import { LocalObjectStore } from "../src/stores.js";

describe("EnvelopeObjectStore", () => {
  it("stores compressed encrypted bytes while exposing plaintext to the engine", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-envelope-store-"),
    );
    try {
      const key = await importAesGcmKey(
        crypto.getRandomValues(new Uint8Array(32)),
        ["encrypt", "decrypt"],
      );
      const delegate = new LocalObjectStore(directory);
      const store = new EnvelopeObjectStore(
        delegate,
        {
          key,
          keyId: "user-1:v1",
          compression: "gzip",
          objectKeyPrefix: "scopes/user-1",
        },
      );
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          id: "private",
          values: Array.from({ length: 100 }, () => "same"),
        }),
      );

      await store.put("nodes/private.bin", plaintext, {
        ifNoneMatch: true,
      });
      const raw = new Uint8Array(
        await readFile(path.join(directory, "nodes", "private.bin")),
      );
      expect(inspectEnvelope(raw)).toMatchObject({
        encrypted: true,
        compressed: true,
        keyId: "user-1:v1",
      });
      expect(new TextDecoder().decode(raw)).not.toContain("private");

      const restored = await store.get("nodes/private.bin");
      expect(restored?.bytes).toEqual(plaintext);

      await store.put(
        "nodes/other.bin",
        new TextEncoder().encode('{"id":"other"}'),
      );
      const firstCiphertext = await delegate.get("nodes/private.bin");
      await delegate.put(
        "nodes/other.bin",
        firstCiphertext!.bytes,
      );
      await expect(store.get("nodes/other.bin")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects objects above its decoded read and write limit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-envelope-limit-"),
    );
    try {
      const delegate = new LocalObjectStore(directory);
      const bounded = new EnvelopeObjectStore(delegate, {
        compression: "gzip",
        maximumDecodedBytes: 1_024,
      });
      const oversized = new TextEncoder().encode("x".repeat(2_048));

      await expect(
        bounded.put("oversized.bin", oversized),
      ).rejects.toThrow("exceeds");

      const permissive = new EnvelopeObjectStore(delegate, {
        compression: "gzip",
        maximumDecodedBytes: oversized.byteLength,
      });
      await permissive.put("oversized.bin", oversized);
      await expect(
        bounded.get("oversized.bin"),
      ).rejects.toThrow("exceeds");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
