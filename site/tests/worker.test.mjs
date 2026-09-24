import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

test("redirects www requests to the canonical apex URL", async () => {
  const response = await worker.fetch(
    new Request("https://www.thimbledb.com/docs/?q=cache"),
    failingAssets(),
  );

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://thimbledb.com/docs/?q=cache",
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("serves apex assets with security and HTML cache headers", async () => {
  const response = await worker.fetch(
    new Request("https://thimbledb.com/docs/"),
    assets(new Response("<h1>Docs</h1>", {
      headers: { "content-type": "text/html" },
    })),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, must-revalidate",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
});

test("uses immutable caching for hashed Astro assets", async () => {
  const response = await worker.fetch(
    new Request("https://thimbledb.com/_astro/site.abc123.css"),
    assets(new Response("body{}")),
  );

  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});

/** @param {Response} response */
function assets(response) {
  return {
    ASSETS: {
      fetch() {
        return Promise.resolve(response);
      },
    },
  };
}

function failingAssets() {
  return {
    ASSETS: {
      fetch() {
        throw new Error("Assets should not be read for www redirects");
      },
    },
  };
}
