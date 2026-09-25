import { expect, test } from "@playwright/test";

test("manages an explicitly granted scope through Studio", async ({
  page,
  browserName,
  request,
}) => {
  const subject = `studio-${browserName}-${crypto.randomUUID()}`;
  const token = await request
    .get(
      `http://127.0.0.1:8790/token?subject=${encodeURIComponent(subject)}&admin=true`,
    )
    .then((response) => response.text());

  await page.goto("http://127.0.0.1:8787/studio/");
  await expect(
    page.getByRole("heading", {
      name: "Inspect a ThimbleDB deployment.",
    }),
  ).toBeVisible();
  await page.locator("#auth-provider").selectOption("e2e");
  await page.locator("#auth-token").fill(token);
  await page.getByRole("button", { name: "Create session" }).click();

  await expect(page.locator("#studio-view")).toBeVisible();
  await expect(page.locator("#scope option").first()).toHaveText(
    /^user:/,
  );
  const scopeId = await page.locator("#scope").inputValue();
  expect(scopeId).toMatch(/^user:/);
  await expect(page.locator("#scope-permissions")).toContainText(
    "write",
  );
  await page
    .locator("#collections")
    .getByRole("button", { name: "products", exact: true })
    .click();

  page.once("dialog", (dialog) => dialog.accept(scopeId));
  await page
    .getByRole("button", { name: "Enable writes" })
    .click();
  await expect(page.locator("#mode-badge")).toHaveText(
    "Writes enabled",
  );

  await page
    .getByRole("button", { name: "New document" })
    .click();
  const documentId = `studio-${crypto.randomUUID()}`;
  await page.locator("#document-json").fill(
    JSON.stringify(
      {
        id: documentId,
        sku: "STUDIO-001",
        name: "Studio product",
        priceCents: 1200,
      },
      null,
      2,
    ),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Save document" })
    .click();

  await page.locator("#query-field").fill("sku");
  await page.locator("#query-value").fill("STUDIO-001");
  await page
    .getByRole("button", { name: "Run bounded query" })
    .click();
  await expect(page.locator("#query-plan")).toContainText(
    "Plan: index (by-sku)",
  );
  await expect(page.locator("#documents")).toContainText(documentId);

  await page
    .locator("#collections")
    .getByRole("button", { name: "customers", exact: true })
    .click();
  await expect(page.locator("#documents")).not.toContainText(
    documentId,
  );
  await page
    .locator("#collections")
    .getByRole("button", { name: "products", exact: true })
    .click();
  await page.locator("#query-field").fill("sku");
  await page.locator("#query-value").fill("STUDIO-001");
  await page
    .getByRole("button", { name: "Run bounded query" })
    .click();
  await expect(page.locator("#documents")).toContainText(documentId);

  await page
    .locator(".document-card")
    .filter({ hasText: documentId })
    .getByRole("button", { name: "Open" })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete document" })
    .click();
  await expect(page.locator("#documents")).not.toContainText(
    documentId,
  );

  await page.getByRole("button", { name: "Deleted" }).click();
  await expect(page.locator("#deleted-documents")).toContainText(
    documentId,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#deleted-documents")
    .filter({ hasText: documentId })
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(page.locator("#deleted-documents")).not.toContainText(
    documentId,
  );

  await page.getByRole("button", { name: "Indexes" }).click();
  await expect(page.locator("#indexes")).toContainText("by-sku");
  await expect(page.locator("#indexes")).toContainText("ready");
  await expect(
    page.getByRole("button", { name: "Rebuild indexes" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Operations" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download NDJSON" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("products.ndjson");

  const forbidden = await page.evaluate(() =>
    fetch(
      "/api/studio/scopes/user%3A00000000-0000-0000-0000-000000000000/collections",
    ).then((response) => response.status),
  );
  expect(forbidden).toBe(403);

  await page.locator("#scope").selectOption("tenant:tenant-e2e");
  await expect(page.locator("#collection-eyebrow")).toHaveText(
    "tenant:tenant-e2e",
  );
  await page.locator("#scope").selectOption(scopeId);
  await expect(page.locator("#collection-eyebrow")).toHaveText(
    scopeId,
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Inspect a ThimbleDB deployment.",
    }),
  ).toBeVisible();
  const cacheCounts = await page.evaluate(async () => {
    const request = indexedDB.open("thimbledb-cache-v1", 2);
    const database = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    const count = (store: "objects" | "keys") =>
      new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(
          store,
          "readonly",
        );
        const operation = transaction.objectStore(store).count();
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
      });
    return {
      objects: await count("objects"),
      keys: await count("keys"),
    };
  });
  expect(cacheCounts).toEqual({
    objects: 0,
    keys: 0,
  });
});
