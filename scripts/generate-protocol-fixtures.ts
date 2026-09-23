import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  bytesToBase64,
  encodeEnvelope,
  importAesGcmKey,
} from "../src/envelope.js";

const encoder = new TextEncoder();
const keyBytes = Uint8Array.from(
  { length: 32 },
  (_, index) => index,
);
const key = await importAesGcmKey(
  keyBytes,
  ["encrypt", "decrypt"],
);

const cases = await Promise.all([
  fixture(
    "public-uncompressed",
    "scopes/public/content-trie/items/HEAD.json",
    encoder.encode('{"ok":true}'),
  ),
  fixture(
    "public-compressed",
    "scopes/public/content-trie/items/nodes/public.json",
    encoder.encode(
      JSON.stringify({
        values: Array.from({ length: 100 }, () => "repeat"),
      }),
    ),
  ),
  fixture(
    "encrypted-compressed",
    "scopes/user%3Afixture/content-trie/items/nodes/private.json",
    encoder.encode(
      JSON.stringify({
        id: "fixture",
        secret: "private",
        values: Array.from({ length: 100 }, () => "repeat"),
      }),
    ),
    {
      key,
      keyId: "user:fixture:v1",
    },
  ),
]);

const output = {
  protocol: "TDB1",
  generatedBy: "scripts/generate-protocol-fixtures.ts",
  testKeys: {
    "user:fixture:v1": bytesToBase64(keyBytes),
  },
  cases,
};

const directory = path.resolve("protocol-fixtures", "v1");
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "envelopes.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);

async function fixture(
  name: string,
  objectKey: string,
  plaintext: Uint8Array,
  encryption?: { key: CryptoKey; keyId: string },
) {
  return {
    name,
    objectKey,
    plaintextBase64: bytesToBase64(plaintext),
    envelopeBase64: bytesToBase64(
      await encodeEnvelope(plaintext, {
        compression: "gzip",
        additionalData: encoder.encode(objectKey),
        ...(encryption ?? {}),
      }),
    ),
  };
}
