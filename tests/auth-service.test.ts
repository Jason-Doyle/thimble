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
    } finally {
      await fixture.cleanup();
    }
  });
});

async function authFixture(): Promise<{
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
      registrationEnabled: true,
      sessionTtlSeconds: 3_600,
      secureCookies: true,
      minimumLoginDurationMs: 0,
    }),
    cleanup: () =>
      rm(directory, { recursive: true, force: true }),
  };
}
