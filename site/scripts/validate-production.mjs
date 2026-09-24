import assert from "node:assert/strict";

const origin = process.env.THIMBLE_SITE_ORIGIN ?? "https://thimbledb.com";
const browserHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
};

const apex = await fetch(`${origin}/`, {
  headers: browserHeaders,
});
assert.equal(apex.status, 200);
assert.equal(apex.headers.get("x-content-type-options"), "nosniff");
assert.equal(apex.headers.get("x-frame-options"), "DENY");
assert.match(
  apex.headers.get("strict-transport-security") ?? "",
  /max-age=31536000/,
);
const html = await apex.text();
assert.match(html, /<link rel="canonical" href="https:\/\/thimbledb\.com\/">/);

const www = await fetch("https://www.thimbledb.com/docs/?source=validation", {
  redirect: "manual",
});
assert.equal(www.status, 308);
assert.equal(
  www.headers.get("location"),
  "https://thimbledb.com/docs/?source=validation",
);

const insecure = await fetch("http://thimbledb.com/", {
  redirect: "manual",
});
assert.ok([301, 302, 307, 308].includes(insecure.status));
assert.match(insecure.headers.get("location") ?? "", /^https:\/\//);

const robots = await fetch(`${origin}/robots.txt`);
assert.equal(robots.status, 200);
const robotsText = await robots.text();
assert.match(robotsText, /User-agent: \*/);
assert.match(robotsText, /Allow: \//);
assert.match(
  robotsText,
  /Content-Signal: search=yes, ai-input=yes, ai-train=yes/,
);

for (const userAgent of [
  "OAI-SearchBot",
  "GPTBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Google-Extended",
]) {
  const response = await fetch(`${origin}/robots.txt`, {
    headers: { "user-agent": userAgent },
  });
  assert.equal(response.status, 200, userAgent);
}

for (const path of [
  "/sitemap-index.xml",
  "/llms.txt",
  "/llms-full.txt",
  "/vibe-coded-apps/",
  "/compare/",
  "/examples/",
]) {
  const response = await fetch(`${origin}${path}`, {
    headers: browserHeaders,
  });
  assert.equal(response.status, 200, path);
}

const missing = await fetch(`${origin}/production-validation-missing`);
assert.equal(missing.status, 404);

const cssPath = html.match(/href="(\/_astro\/[^"]+\.css)"/)?.[1];
assert.ok(cssPath);
const css = await fetch(`${origin}${cssPath}`);
assert.equal(
  css.headers.get("cache-control"),
  "public, max-age=31536000, immutable",
);

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  let rumStatus = null;
  page.on("response", (response) => {
    if (response.url().includes("/cdn-cgi/rum")) {
      rumStatus = response.status();
    }
  });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1_000);
  assert.equal(
    await page
      .locator('script[src*="static.cloudflareinsights.com/beacon.min.js"]')
      .count(),
    1,
  );
  assert.equal(rumStatus, 204);
  assert.deepEqual(await context.cookies(origin), []);
} finally {
  await browser.close();
}

console.log(`Validated Cloudflare production configuration at ${origin}.`);
