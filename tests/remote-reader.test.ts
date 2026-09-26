import { describe, expect, it } from "vitest";
import {
  EnvelopeJsonObjectReader,
  HttpJsonObjectReader,
  ScopedJsonObjectReader,
  type ByteObjectReader,
} from "../src/browser/remote-reader.js";
import {
  encodeEnvelope,
  importAesGcmKey,
} from "../src/envelope.js";

describe("HttpJsonObjectReader", () => {
  it("invokes browser fetch with the global receiver", async () => {
    const receiverSensitiveFetch = function (
      this: typeof globalThis,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      expect(String(input)).toBe(
        "https://storage.example.test/base/path/object.json?sig=read",
      );
      expect(new Headers(init?.headers).get("If-None-Match")).toBe(
        '"etag-0"',
      );
      return Promise.resolve(
        new Response('{"value":1}', {
          status: 200,
          headers: { etag: '"etag-1"' },
        }),
      );
    } as typeof fetch;

    const reader = new HttpJsonObjectReader(
      "https://storage.example.test/base?sig=read",
      receiverSensitiveFetch,
    );

    await expect(
      reader.get("path/object.json", "etag-0"),
    ).resolves.toMatchObject({
      status: "found",
      etag: '"etag-1"',
      value: { value: 1 },
    });
  });

  it("decodes encrypted scoped objects without exposing raw bytes", async () => {
    const key = await importAesGcmKey(
      crypto.getRandomValues(new Uint8Array(32)),
      ["encrypt", "decrypt"],
    );
    const envelope = await encodeEnvelope(
      new TextEncoder().encode('{"private":true}'),
      {
        key,
        keyId: "user:v1",
        additionalData: new TextEncoder().encode(
          "scopes/user/content-trie/items/HEAD.json",
        ),
      },
    );
    const physicalKeys: string[] = [];
    const bytes: ByteObjectReader = {
      async get(objectKey) {
        physicalKeys.push(objectKey);
        return {
          status: "found",
          key: objectKey,
          etag: '"cipher-etag"',
          bytes: envelope,
        };
      },
    };
    const reader = new ScopedJsonObjectReader(
      new EnvelopeJsonObjectReader(bytes, () => key),
      "user",
    );

    await expect(reader.get("content-trie/items/HEAD.json")).resolves.toEqual({
        status: "found",
        key: "content-trie/items/HEAD.json",
        etag: '"cipher-etag"',
        value: { private: true },
        bytes: envelope.byteLength,
      });
    expect(physicalKeys).toEqual([
      "scopes/user/content-trie/items/HEAD.json",
    ]);
  });

  it("rejects browser envelope output above the configured limit", async () => {
    const plaintext = new TextEncoder().encode("x".repeat(2_048));
    const envelope = await encodeEnvelope(plaintext);
    const bytes: ByteObjectReader = {
      get(objectKey) {
        return Promise.resolve({
          status: "found",
          key: objectKey,
          etag: '"etag"',
          bytes: envelope,
        });
      },
    };
    const reader = new EnvelopeJsonObjectReader(
      bytes,
      undefined,
      1_024,
    );

    await expect(reader.get("oversized.json")).rejects.toThrow(
      "exceeds",
    );
  });
});
