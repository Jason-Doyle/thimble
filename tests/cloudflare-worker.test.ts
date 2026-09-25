import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AuthError } from "../src/auth/service.js";
import worker, {
  createCloudflareAuthority,
  readJsonRequest,
} from "../src/cloudflare-worker.js";
import type { R2BucketBinding } from "../src/cloudflare/r2-object-store.js";

describe("Cloudflare Worker request parsing", () => {
  it("parses bounded JSON request bodies", async () => {
    await expect(
      readJsonRequest(
        new Request("https://db.example.test/api", {
          method: "POST",
          body: JSON.stringify({ id: "one" }),
        }),
      ),
    ).resolves.toEqual({ id: "one" });
  });

  it("reports malformed JSON as a client error", async () => {
    const result = readJsonRequest(
      new Request("https://db.example.test/api", {
        method: "POST",
        body: "{",
      }),
    );

    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
    });
  });

  it("rejects declared bodies above the authority limit", async () => {
    await expect(
      readJsonRequest(
        new Request("https://db.example.test/api", {
          method: "POST",
          headers: {
            "content-length": "1048577",
          },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
  });

  it("ships lifecycle rules in Wrangler's R2 schema", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL(
          "../deploy/cloudflare/auth-lifecycle.example.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      rules?: Array<{
        enabled?: boolean;
        conditions?: { prefix?: string };
        deleteObjectsTransition?: {
          condition?: { type?: string; maxAge?: number };
        };
      }>;
    };

    expect(policy.rules).toHaveLength(2);
    for (const rule of policy.rules ?? []) {
      expect(rule.enabled).toBe(true);
      expect(rule.conditions?.prefix).toMatch(
        /^auth-v1\/(sessions|rate-limits)\/$/,
      );
      expect(rule.deleteObjectsTransition?.condition).toEqual({
        type: "Age",
        maxAge: 604_800,
      });
    }
  });

  it("advertises only configured external identity providers", async () => {
    const bucket = emptyBucket();
    const environment = {
      DB: bucket,
      AUTH_DB: bucket,
      THIMBLE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      THIMBLE_ALLOWED_ORIGIN: "https://db.example.test",
      ASSETS: {
        fetch: async () =>
          new Response("<html>fallback</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      },
      OIDC_PROVIDER_ID: "generic",
      OIDC_ISSUER: "https://identity.example.test",
      OIDC_AUDIENCE: "thimbledb",
      OIDC_JWKS_URI: "https://identity.example.test/jwks",
      OIDC_REQUIRED_SCOPE: "thimble.access",
    };

    const config = await worker.fetch(
      new Request("https://db.example.test/api/auth/config"),
      environment as never,
    );
    await expect(config.json()).resolves.toEqual({
      oidcProviders: ["generic"],
    });

    const removedRoute = await worker.fetch(
      new Request("https://db.example.test/api/auth/register", {
        method: "POST",
        headers: {
          origin: "https://db.example.test",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      environment as never,
    );
    expect(removedRoute.status).toBe(404);
    await expect(removedRoute.json()).resolves.toEqual({
      error: "not_found",
    });
  });

  it("keeps Studio opt-in and session protected", async () => {
    const bucket = emptyBucket();
    const environment = {
      DB: bucket,
      AUTH_DB: bucket,
      THIMBLE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      THIMBLE_ALLOWED_ORIGIN: "https://db.example.test",
    };

    const disabled = await worker.fetch(
      new Request("https://db.example.test/api/studio"),
      environment as never,
    );
    expect(disabled.status).toBe(404);

    const enabled = await createCloudflareAuthority({
      studio: true,
    }).fetch(
      new Request("https://db.example.test/api/studio"),
      environment as never,
    );
    expect(enabled.status).toBe(401);

    const missingOrigin = await createCloudflareAuthority().fetch(
      new Request(
        "https://db.example.test/api/auth/oidc/unknown/session",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer invalid",
          },
          body: "{}",
        },
      ),
      environment as never,
    );
    expect(missingOrigin.status).toBe(403);
    await expect(missingOrigin.json()).resolves.toMatchObject({
      error: "origin_rejected",
    });

    const disabledBundle = await createCloudflareAuthority().fetch(
      new Request(
        "https://db.example.test/api/read-bundles/public/notes/note-1",
      ),
      environment as never,
    );
    expect(disabledBundle.status).toBe(404);

    const bundle = await createCloudflareAuthority({
      readBundles: true,
    }).fetch(
      new Request(
        "https://db.example.test/api/read-bundles/public/notes/note-1",
      ),
      environment as never,
    );
    expect(bundle.status).toBe(401);
  });

  it("does not apply Studio catalog limits when Studio is disabled", async () => {
    const bucket = emptyBucket();
    const collectionLayouts = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [
        `collection-${index}`,
        "trie" as const,
      ]),
    );
    const authority = createCloudflareAuthority({
      collectionLayouts,
    });
    const response = await authority.fetch(
      new Request("https://db.example.test/api/auth/config"),
      {
        DB: bucket,
        AUTH_DB: bucket,
        THIMBLE_MASTER_KEY: Buffer.alloc(32, 7).toString(
          "base64",
        ),
        THIMBLE_ALLOWED_ORIGIN: "https://db.example.test",
      } as never,
    );

    expect(response.status).toBe(200);
  });
});

function emptyBucket(): R2BucketBinding {
  return {
    get: async () => null,
    put: async () => ({ etag: "unused" }),
    delete: async () => undefined,
    list: async () => ({
      objects: [],
      truncated: false,
    }),
  };
}
