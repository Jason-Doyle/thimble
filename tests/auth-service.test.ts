import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  AuthService,
} from "../src/auth/service.js";
import { DefaultScopeAuthorizer } from "../src/auth/policy.js";
import { InMemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthRepository } from "../src/auth/repository.js";
import type {
  ExternalIdentity,
  IdentityAdapter,
} from "../src/auth/types.js";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import { importAesGcmKey } from "../src/envelope.js";
import { LocalObjectStore } from "../src/stores.js";

describe("AuthService", () => {
  it("authenticates, authorises, and revokes an external session", async () => {
    const adapter = mutableAdapter(externalIdentity());
    const fixture = await authFixture(adapter);
    try {
      const authenticated = await fixture.auth.loginExternal(
        adapter.id,
        "token",
        "127.0.0.1",
      );

      expect(authenticated.session.grants).toContainEqual({
        scopeId: `user:${authenticated.user.id}`,
        permissions: ["read", "write"],
      });
      expect(
        fixture.auth.sessionCookie(authenticated.cookieValue),
      ).toContain("HttpOnly");
      expect(
        await fixture.auth.authenticate(authenticated.cookieValue),
      ).not.toBeNull();
      expect(() =>
        fixture.auth.requireCsrf(
          authenticated.session.csrfToken,
          "wrong",
        ),
      ).toThrow(AuthError);

      await fixture.auth.logout(authenticated.cookieValue);
      expect(
        await fixture.auth.authenticate(authenticated.cookieValue),
      ).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses one invalid-credentials response for missing providers and rejected tokens", async () => {
    const adapter = mutableAdapter(null);
    const fixture = await authFixture(adapter);
    try {
      await expect(
        fixture.auth.loginExternal("missing", "token", null),
      ).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
      await expect(
        fixture.auth.loginExternal(adapter.id, "token", null),
      ).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("refreshes removed external roles for new and existing sessions", async () => {
    const adapter = mutableAdapter(
      externalIdentity(["thimble.tenant.writer"]),
    );
    const fixture = await authFixture(adapter);
    try {
      const first = await fixture.auth.loginExternal(
        adapter.id,
        "token",
        null,
      );
      expect(first.session.grants).toContainEqual({
        scopeId: "tenant:tenant-1",
        permissions: ["read", "write"],
      });

      adapter.identity = externalIdentity([]);
      const second = await fixture.auth.loginExternal(
        adapter.id,
        "token",
        null,
      );

      expect(second.user.id).toBe(first.user.id);
      expect(second.session.grants).toContainEqual({
        scopeId: "tenant:tenant-1",
        permissions: ["read"],
      });
      await expect(
        fixture.auth.authenticate(first.cookieValue),
      ).resolves.toMatchObject({
        session: {
          grants: expect.arrayContaining([
            {
              scopeId: "tenant:tenant-1",
              permissions: ["read"],
            },
          ]),
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

async function authFixture(
  adapter: MutableIdentityAdapter,
): Promise<{
  auth: AuthService;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "thimbledb-auth-service-"),
  );
  const key = await importAesGcmKey(
    crypto.getRandomValues(new Uint8Array(32)),
    ["encrypt", "decrypt"],
  );
  const indexKey = crypto.getRandomValues(new Uint8Array(32));
  const repository = new AuthRepository(
    new EnvelopeObjectStore(
      new LocalObjectStore(directory),
      {
        key,
        keyId: "system-auth:v1",
        objectKeyPrefix: "auth-v1",
      },
    ),
    (value) =>
      createHmac("sha256", indexKey)
        .update(value)
        .digest("hex"),
    (value) =>
      createHash("sha256").update(value).digest("hex"),
  );
  return {
    auth: new AuthService({
      repository,
      authorizer: new DefaultScopeAuthorizer(),
      rateLimiter: new InMemoryAuthRateLimiter(20),
      identityAdapters: new Map([[adapter.id, adapter]]),
      sessionTtlSeconds: 3_600,
      secureCookies: true,
    }),
    cleanup: () =>
      rm(directory, { recursive: true, force: true }),
  };
}

type MutableIdentityAdapter = IdentityAdapter & {
  identity: ExternalIdentity | null;
};

function mutableAdapter(
  identity: ExternalIdentity | null,
): MutableIdentityAdapter {
  return {
    id: "entra",
    identity,
    async authenticate() {
      return this.identity;
    },
  };
}

function externalIdentity(
  roles = ["reader"],
): ExternalIdentity {
  return {
    provider: "entra",
    issuer: "https://issuer.example",
    subject: "object-1",
    tenantId: "tenant-1",
    roles,
    scopes: ["thimble.read"],
  };
}
