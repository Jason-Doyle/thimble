import { expect, test } from "@playwright/test";

test("registers, reads, writes, persists cache, and logs out", async ({
  page,
  browserName,
}) => {
  const login = `${browserName}-${crypto.randomUUID()}@example.test`;
  const password = "correct horse battery staple";

  await page.goto("/");
  await expect(page.locator("#auth-panel")).toBeVisible();
  await page.locator("#auth-login").fill(login);
  await page.locator("#auth-password").fill(password);
  await page.locator("#register").click();
  await expect(page.locator("#auth-message")).toContainText(
    "available for login",
  );

  await page.locator("#login").click();
  await expect(page.locator("#status")).toContainText("Ready:");
  await expect(page.locator("#auth-panel")).toBeHidden();

  await page.locator("#seed").click();
  await expect(page.locator("#benchmark-output")).toContainText(
    '"products": 128',
  );

  await page.locator("#read-product").click();
  await expect(page.locator("#product-output")).toContainText(
    "product-00000",
  );

  await page.reload();
  await expect(page.locator("#status")).toContainText("Ready:");
  await page.locator("#read-product").click();
  await expect(page.locator("#product-output")).toContainText(
    "product-00000",
  );

  await page.locator("#logout").click();
  await expect(page.locator("#auth-panel")).toBeVisible();
  await expect(page.locator("#status")).toContainText(
    "Sign in required",
  );
});

test("decodes committed TDB1 fixtures in the browser runtime", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    // @ts-expect-error Vite serves this source module during browser QA.
    const codec = await import("/src/envelope.ts");
    const fixture = await fetch(
      "/protocol-fixtures/v1/envelopes.json",
    ).then((response) => response.json()) as {
      testKeys: Record<string, string>;
      cases: Array<{
        name: string;
        objectKey: string;
        plaintextBase64: string;
        envelopeBase64: string;
      }>;
    };
    const keys = new Map<string, CryptoKey>();
    for (const [keyId, raw] of Object.entries(fixture.testKeys)) {
      keys.set(
        keyId,
        await codec.importAesGcmKey(
          codec.base64ToBytes(raw),
          ["decrypt"],
        ),
      );
    }
    const decoded: string[] = [];
    for (const item of fixture.cases) {
      const plaintext = await codec.decodeEnvelope(
        codec.base64ToBytes(item.envelopeBase64),
        (keyId: string) => keys.get(keyId) ?? null,
        new TextEncoder().encode(item.objectKey),
      );
      if (
        codec.bytesToBase64(plaintext) !==
        item.plaintextBase64
      ) {
        throw new Error(`Fixture ${item.name} did not match`);
      }
      decoded.push(item.name);
    }
    return decoded;
  });

  expect(results).toEqual([
    "public-uncompressed",
    "public-compressed",
    "encrypted-compressed",
  ]);
});
