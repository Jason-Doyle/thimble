import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  encodeEnvelope,
  importAesGcmKey,
  inspectEnvelope,
} from "../src/envelope.js";

describe("ThimbleDB binary envelope", () => {
  it("compresses repetitive public JSON when that reduces the payload", async () => {
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        values: Array.from({ length: 200 }, () => "repeated-value"),
      }),
    );
    const envelope = await encodeEnvelope(plaintext);
    const metadata = inspectEnvelope(envelope);

    expect(metadata.compressed).toBe(true);
    expect(metadata.encrypted).toBe(false);
    expect(envelope.byteLength).toBeLessThan(plaintext.byteLength);
    expect(await decodeEnvelope(envelope)).toEqual(plaintext);
  });

  it("keeps tiny public values uncompressed when gzip would be larger", async () => {
    const plaintext = new TextEncoder().encode('{"ok":true}');
    const envelope = await encodeEnvelope(plaintext);

    expect(inspectEnvelope(envelope).compressed).toBe(false);
    expect(await decodeEnvelope(envelope)).toEqual(plaintext);
  });

  it("compresses before AES-256-GCM encryption and authenticates metadata", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAesGcmKey(
      rawKey,
      ["encrypt", "decrypt"],
    );
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        secret: "private",
        values: Array.from({ length: 100 }, () => "compress-me"),
      }),
    );
    const envelope = await encodeEnvelope(plaintext, {
      key,
      keyId: "tenant-a:v1",
    });
    const metadata = inspectEnvelope(envelope);

    expect(metadata).toMatchObject({
      compressed: true,
      encrypted: true,
      keyId: "tenant-a:v1",
    });
    expect(
      await decodeEnvelope(envelope, (keyId) =>
        keyId === "tenant-a:v1" ? key : null,
      ),
    ).toEqual(plaintext);
  });

  it("rejects decryption with the wrong key", async () => {
    const encryptionKey = await importAesGcmKey(
      crypto.getRandomValues(new Uint8Array(32)),
      ["encrypt"],
    );
    const wrongKey = await importAesGcmKey(
      crypto.getRandomValues(new Uint8Array(32)),
      ["decrypt"],
    );
    const envelope = await encodeEnvelope(
      new TextEncoder().encode('{"secret":true}'),
      {
        key: encryptionKey,
        keyId: "private:v1",
      },
    );

    await expect(
      decodeEnvelope(envelope, () => wrongKey),
    ).rejects.toThrow();
  });

  it("binds encrypted payloads to their object key", async () => {
    const key = await importAesGcmKey(
      crypto.getRandomValues(new Uint8Array(32)),
      ["encrypt", "decrypt"],
    );
    const envelope = await encodeEnvelope(
      new TextEncoder().encode('{"id":"one"}'),
      {
        key,
        keyId: "private:v1",
        additionalData: new TextEncoder().encode("nodes/one"),
      },
    );

    await expect(
      decodeEnvelope(
        envelope,
        () => key,
        new TextEncoder().encode("nodes/two"),
      ),
    ).rejects.toThrow();
  });

  it("streams large incompressible and expanding payloads without deadlock", async () => {
    const random = new Uint8Array(randomBytes(128 * 1024));
    const publicEnvelope = await encodeEnvelope(random);
    await expect(decodeEnvelope(publicEnvelope)).resolves.toEqual(random);

    const repetitive = new TextEncoder().encode("x".repeat(512 * 1024));
    const compressed = await encodeEnvelope(repetitive);
    expect(inspectEnvelope(compressed).compressed).toBe(true);
    await expect(decodeEnvelope(compressed)).resolves.toEqual(repetitive);
  });

  it("rejects compressed output while it exceeds a decoded limit", async () => {
    const plaintext = new TextEncoder().encode(
      "bounded-output".repeat(100_000),
    );
    const envelope = await encodeEnvelope(plaintext);
    expect(inspectEnvelope(envelope).compressed).toBe(true);

    await expect(
      decodeEnvelope(
        envelope,
        undefined,
        undefined,
        { maximumDecodedBytes: 64 * 1024 },
      ),
    ).rejects.toThrow("exceeds");
    await expect(
      decodeEnvelope(
        envelope,
        undefined,
        undefined,
        { maximumDecodedBytes: plaintext.byteLength },
      ),
    ).resolves.toEqual(plaintext);
  });
});
