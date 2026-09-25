import { expect, test } from "@playwright/test";

test("authenticates externally, reads, writes, persists cache, and logs out", async ({
  page,
  browserName,
  request,
}) => {
  const bundleRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/read-bundles/")) {
      bundleRequests.push(request.url());
    }
  });
  const subject = `${browserName}-${crypto.randomUUID()}`;
  const token = await request
    .get(
      `http://127.0.0.1:8790/token?subject=${encodeURIComponent(subject)}&admin=true`,
    )
    .then((response) => response.text());

  await page.goto("/");
  await expect(page.locator("#auth-panel")).toBeVisible();
  await page.locator("#auth-provider").selectOption("e2e");
  await page.locator("#auth-token").fill(token);
  await page.locator("#oidc-login").click();
  await expect(page.locator("#status")).toContainText("Ready:");
  await expect(page.locator("#auth-panel")).toBeHidden();
  await expect(page.locator("#admin-panel")).toBeVisible();
  const currentUserId = await page.evaluate(() =>
    fetch("/api/config").then(async (response) => {
      const config = await response.json() as {
        user: { id: string };
      };
      return config.user.id;
    }),
  );
  await page.locator("#admin-user").selectOption(currentUserId);
  await expect(page.locator("#admin-output")).toContainText(subject);

  const linkedSubject = `${subject}-linked`;
  const linkedToken = await request
    .get(
      `http://127.0.0.1:8790/token?subject=${encodeURIComponent(linkedSubject)}`,
    )
    .then((response) => response.text());
  await page.locator("#link-provider").selectOption("e2e");
  await page.locator("#link-token").fill(linkedToken);
  await page.locator("#link-identity").click();
  await expect(page.locator("#status")).toContainText("Ready:");
  await expect(page.locator("#identity-output")).toContainText(
    linkedSubject,
  );

  await page.locator("#seed").click();
  await expect(page.locator("#benchmark-output")).toContainText(
    '"products": 128',
  );

  const oversizedProjection = await page.evaluate(async () => {
    const config = await fetch("/api/config", {
      credentials: "same-origin",
      cache: "no-store",
    }).then((response) => response.json()) as {
      csrfToken: string;
      layoutGeneration: string;
      scope: { id: string };
    };
    const response = await fetch(
      "/api/collections/products/documents/oversized-cover",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-thimble-csrf": config.csrfToken,
          "x-thimble-scope": config.scope.id,
          "x-thimble-layout-generation":
            config.layoutGeneration,
        },
        body: JSON.stringify({
          id: "oversized-cover",
          sku: "OVERSIZED",
          name: "x".repeat(70 * 1024),
          priceCents: 1,
        }),
      },
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  });
  expect(oversizedProjection).toMatchObject({
    status: 413,
    body: {
      error: "secondary_index_too_large",
    },
  });

  await page.locator("#read-product").click();
  await expect(page.locator("#product-output")).toContainText(
    "product-00000",
  );
  expect(bundleRequests).toHaveLength(1);

  await page.locator("#delete-product").click();
  await expect(page.locator("#status")).toContainText(
    "Product deleted",
  );
  await page.locator("#read-product").click();
  await expect(page.locator("#product-output")).toContainText(
    '"product": null',
  );
  await page.locator("#restore-product").click();
  await expect(page.locator("#status")).toContainText(
    "Product restored",
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
