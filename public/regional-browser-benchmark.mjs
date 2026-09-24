import { chromium } from "playwright";

const token = process.env.THIMBLE_TOKEN;
const region = process.env.THIMBLE_REGION ?? "unknown";
const target = process.env.THIMBLE_URL ?? "https://db.thimbledb.com";
if (!token) {
  throw new Error("THIMBLE_TOKEN is required");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(240_000);
  const navigationStarted = performance.now();
  await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.locator("#auth-provider").waitFor();
  const navigationMs = performance.now() - navigationStarted;

  await page.locator("#auth-provider").selectOption("entra");
  await page.locator("#auth-token").fill(token);
  const authenticationStarted = performance.now();
  await page.locator("#oidc-login").click();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.includes("Ready:"),
  );
  const authenticationMs =
    performance.now() - authenticationStarted;

  await page.locator("#clear-all").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#status")
        ?.textContent?.includes("Memory and IndexedDB"),
  );

  await page.locator("#read-product").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "Product loaded",
  );
  const coldPointRead = JSON.parse(
    await page.locator("#product-output").textContent(),
  );

  await page.locator("#reset-metrics").click();
  await page.locator("#benchmark-reads").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "Hot-read benchmark complete",
  );
  const hotReads = JSON.parse(
    await page.locator("#benchmark-output").textContent(),
  );

  await page.locator("#clear-all").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#status")
        ?.textContent?.includes("Memory and IndexedDB"),
  );
  await page.locator("#reset-metrics").click();
  await page.locator("#scan-customers").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "Customer snapshot scan complete",
  );
  const snapshotScan = JSON.parse(
    await page.locator("#benchmark-output").textContent(),
  );

  console.log(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      region,
      target,
      browserVersion: browser.version(),
      navigationMs,
      authenticationMs,
      coldPointRead,
      hotReads,
      snapshotScan,
    }),
  );
} finally {
  await browser.close();
}
