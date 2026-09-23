import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  decodeEnvelope,
  importAesGcmKey,
  inspectEnvelope,
} from "../src/envelope.js";

type FixtureFile = {
  protocol: string;
  testKeys: Record<string, string>;
  cases: Array<{
    name: string;
    objectKey: string;
    plaintextBase64: string;
    envelopeBase64: string;
  }>;
};

describe("TDB1 protocol fixtures", () => {
  it("decodes every committed v1 envelope fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        path.resolve(
          "protocol-fixtures",
          "v1",
          "envelopes.json",
        ),
        "utf8",
      ),
    ) as FixtureFile;
    expect(fixture.protocol).toBe("TDB1");

    const keys = new Map<string, CryptoKey>();
    for (const [keyId, raw] of Object.entries(fixture.testKeys)) {
      keys.set(
        keyId,
        await importAesGcmKey(
          base64ToBytes(raw),
          ["decrypt"],
        ),
      );
    }

    for (const item of fixture.cases) {
      const envelope = base64ToBytes(item.envelopeBase64);
      const metadata = inspectEnvelope(envelope);
      const plaintext = await decodeEnvelope(
        envelope,
        (keyId) => keys.get(keyId) ?? null,
        new TextEncoder().encode(item.objectKey),
      );
      expect(plaintext, item.name).toEqual(
        base64ToBytes(item.plaintextBase64),
      );
      if (item.name.startsWith("encrypted")) {
        expect(metadata.encrypted).toBe(true);
      }
    }
  });
});
