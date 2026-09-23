import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  AuthService,
} from "../src/auth/service.js";
import { PasswordHasher } from "../src/auth/password.js";
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
  it("registers, authenticates, authorises, and revokes a local session", async () => {
    const fixture = await authFixture();
    try {
      await fixture.auth.register(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.1",
      );
      const authenticated = await fixture.auth.login(
        "person@example.test",
        "correct horse battery staple",
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

  it("returns the same invalid-credentials error for missing and incorrect accounts", async () => {
    const fixture = await authFixture();
    try {
      await fixture.auth.register(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.1",
      );

      const missing = fixture.auth.login(
        "missing@example.test",
        "incorrect but long enough",
        "198.51.100.1",
      );
      const wrong = fixture.auth.login(
        "person@example.test",
        "incorrect but long enough",
        "198.51.100.2",
      );

      await expect(missing).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
      await expect(wrong).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
      await expect(
        fixture.auth.login(
          "x",
          "incorrect but long enough",
          "198.51.100.3",
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("bounds password work even when no source IP is available", async () => {
    const fixture = await authFixture({
      passwordWorkLimit: 2,
    });
    try {
      await expect(
        fixture.auth.login("x", "long enough password", null),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        fixture.auth.login("y", "long enough password", null),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        fixture.auth.login("z", "long enough password", null),
      ).rejects.toMatchObject({
        status: 429,
        code: "rate_limited",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("changes passwords and revokes every existing session", async () => {
    const fixture = await authFixture();
    try {
      await fixture.auth.register(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.1",
      );
      const first = await fixture.auth.login(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.1",
      );
      const second = await fixture.auth.login(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.2",
      );

      await fixture.auth.changePassword(
        first,
        "correct horse battery staple",
        "a different secure horse battery",
      );
      await expect(
        fixture.auth.changePassword(
          second,
          "correct horse battery staple",
          "attacker selected replacement",
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "reauthentication_required",
      });

      expect(
        await fixture.auth.authenticate(first.cookieValue),
      ).toBeNull();
      expect(
        await fixture.auth.authenticate(second.cookieValue),
      ).toBeNull();
      await expect(
        fixture.auth.login(
          "person@example.test",
          "correct horse battery staple",
          "127.0.0.3",
        ),
      ).rejects.toMatchObject({
        code: "invalid_credentials",
      });
      await expect(
        fixture.auth.login(
          "person@example.test",
          "a different secure horse battery",
          "127.0.0.4",
        ),
      ).resolves.toMatchObject({
        user: { id: first.user.id },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("allows only one concurrent password change from stale sessions", async () => {
    const fixture = await authFixture();
    try {
      await fixture.auth.register(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.1",
      );
      const first = await fixture.auth.login(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.1",
      );
      const second = await fixture.auth.login(
        "person@example.test",
        "correct horse battery staple",
        "127.0.0.2",
      );

      const results = await Promise.allSettled([
        fixture.auth.changePassword(
          first,
          "correct horse battery staple",
          "first concurrent replacement",
        ),
        fixture.auth.changePassword(
          second,
          "correct horse battery staple",
          "second concurrent replacement",
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      );
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: {
          status: 409,
          code: "reauthentication_required",
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("removes stale external roles and recalculates grants", async () => {
    let identity: ExternalIdentity = {
      provider: "entra",
      issuer: "https://issuer.example",
      subject: "object-1",
      tenantId: "tenant-1",
      roles: ["thimble.tenant.writer"],
      scopes: ["thimble.read"],
    };
    const adapter: IdentityAdapter = {
      id: "entra",
      authenticate: async () => identity,
    };
    const fixture = await authFixture({
      identityAdapters: new Map([[adapter.id, adapter]]),
      externalAutoProvision: true,
    });
    try {
      const first = await fixture.auth.loginExternal(
        "entra",
        "token",
        null,
      );
      expect(first.session.grants).toContainEqual({
        scopeId: "tenant:tenant-1",
        permissions: ["read", "write"],
      });

      identity = {
        ...identity,
        roles: [],
      };
      const second = await fixture.auth.loginExternal(
        "entra",
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

async function authFixture(options?: {
  identityAdapters?: Map<string, IdentityAdapter>;
  externalAutoProvision?: boolean;
  passwordWorkLimit?: number;
}): Promise<{
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
  await repository.ensureDummyUser();
  return {
    auth: new AuthService({
      repository,
      passwords: new PasswordHasher(
        crypto.getRandomValues(new Uint8Array(32)),
        { memorySizeKiB: 1_024, iterations: 2 },
      ),
      authorizer: new DefaultScopeAuthorizer(),
      rateLimiter: new InMemoryAuthRateLimiter(20),
      passwordWorkRateLimiter: new InMemoryAuthRateLimiter(
        options?.passwordWorkLimit ?? 100,
      ),
      registrationEnabled: true,
      sessionTtlSeconds: 3_600,
      secureCookies: true,
      minimumLoginDurationMs: 0,
      ...(options?.identityAdapters
        ? { identityAdapters: options.identityAdapters }
        : {}),
      ...(options?.externalAutoProvision !== undefined
        ? {
            externalAutoProvision:
              options.externalAutoProvision,
          }
        : {}),
    }),
    cleanup: () =>
      rm(directory, { recursive: true, force: true }),
  };
}
