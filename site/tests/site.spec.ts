import { expect, test, type Page } from "@playwright/test";

test("homepage presents the product and complete SEO metadata", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle(
    "ThimbleDB: An encrypted database for small web apps",
  );
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "A small database for small web apps.",
    }),
  ).toBeVisible();
  await expect(
    page.locator('link[rel="canonical"]'),
  ).toHaveAttribute("href", "https://thimbledb.com/");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /encrypted, browser-first database/i,
  );
  await expect(
    page.locator('script[type="application/ld+json"]'),
  ).toHaveCount(2);
  await expect(
    page.getByRole("img", { name: "ThimbleDB" }),
  ).toHaveJSProperty("complete", true);
  await assertNoHorizontalOverflow(page);
});

test("repository documentation renders with rewritten internal links", async ({
  page,
}) => {
  await page.goto("/docs/quickstart/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Quickstart" }),
  ).toBeVisible();
  await expect(
    page.locator(".prose").getByRole("link", {
      name: "Authentication",
      exact: true,
    }),
  ).toHaveAttribute("href", "/docs/authentication/");
  await expect(page.locator('.prose a[href$=".md"]')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test("documentation search returns relevant repository pages", async ({
  page,
}) => {
  await page.goto("/search/");
  await page.getByRole("searchbox").fill("deletion retention");
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page.getByText(/\d+ results?/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Deletion and retention/ }),
  ).toBeVisible();
});

test("FAQ publishes structured answers and user-facing content", async ({
  page,
}) => {
  await page.goto("/faq/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Frequently asked questions",
    }),
  ).toBeVisible();
  const schemas = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  expect(schemas.some((schema) => schema.includes('"FAQPage"'))).toBe(true);
  await expect(page.getByText(/does not claim SQL/i)).toBeVisible();
});

test("AI discovery routes publish explicit access and decision content", async ({
  page,
  request,
}) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  const robotsText = await robots.text();
  expect(robotsText).toContain("User-agent: *");
  expect(robotsText).toContain("Allow: /");
  expect(robotsText).toContain(
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
  );

  const llms = await request.get("/llms.txt");
  expect(llms.ok()).toBe(true);
  expect(await llms.text()).toContain(
    "Should you use ThimbleDB for a vibe-coded app?",
  );

  const full = await request.get("/llms-full.txt");
  expect(full.ok()).toBe(true);
  expect(await full.text()).toContain("ThimbleDB and Cloudflare D1");

  await page.goto("/vibe-coded-apps/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Should you use ThimbleDB for a vibe-coded app?",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Cloudflare D1", exact: true }),
  ).toBeVisible();
});

test("every sitemap page has a successful response and one H1", async ({
  page,
  request,
}) => {
  const sitemapIndex = await request.get("/sitemap-index.xml");
  expect(sitemapIndex.ok()).toBe(true);
  const sitemapIndexXml = await sitemapIndex.text();
  const sitemapPaths = extractLocations(sitemapIndexXml);
  expect(sitemapPaths.length).toBeGreaterThan(0);

  const pageUrls: string[] = [];
  const internalPaths = new Set<string>();
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const sitemapPath of sitemapPaths) {
    const sitemap = await request.get(sitemapPath);
    expect(sitemap.ok()).toBe(true);
    pageUrls.push(...extractLocations(await sitemap.text()));
  }

  for (const url of pageUrls) {
    const path = new URL(url).pathname;
    const response = await page.goto(path);
    expect(response?.ok(), path).toBe(true);
    await expect(page.locator("h1"), path).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]'), path).toHaveCount(1);
    await expect(page.locator('meta[name="description"]'), path).toHaveCount(1);
    const title = await page.title();
    const description =
      (await page.locator('meta[name="description"]').getAttribute("content")) ??
      "";
    const canonical =
      (await page.locator('link[rel="canonical"]').getAttribute("href")) ?? "";
    expect(title.length, `${path} title length`).toBeLessThanOrEqual(65);
    expect(description.length, `${path} description length`).toBeGreaterThan(50);
    expect(description.length, `${path} description length`).toBeLessThanOrEqual(
      170,
    );
    expect(new URL(canonical).pathname, `${path} canonical`).toBe(path);
    expect(titles.has(title), `${path} duplicate title`).toBe(false);
    expect(descriptions.has(description), `${path} duplicate description`).toBe(
      false,
    );
    titles.add(title);
    descriptions.add(description);
    const schemas = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();
    for (const schema of schemas) {
      expect(() => JSON.parse(schema), `${path} structured data`).not.toThrow();
    }
    const links = await page.locator("a[href]").evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
    );
    for (const href of links) {
      if (!href || href.startsWith("#")) {
        continue;
      }
      const target = new URL(href, "http://127.0.0.1:4321");
      if (target.origin === "http://127.0.0.1:4321") {
        internalPaths.add(target.pathname);
      }
    }
  }

  for (const path of internalPaths) {
    const response = await request.get(path);
    expect(response.ok(), path).toBe(true);
  }
});

test("mobile navigation remains usable without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");

  await page
    .locator(".mobile-navigation")
    .getByLabel("Open navigation")
    .click();
  await expect(
    page
      .locator(".mobile-navigation")
      .getByRole("link", { name: "Docs", exact: true }),
  ).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

function extractLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1]!,
  );
}
