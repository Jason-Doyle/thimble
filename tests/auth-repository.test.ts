import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthRepository } from "../src/auth/repository.js";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import { importAesGcmKey } from "../src/envelope.js";
import { LocalObjectStore } from "../src/stores.js";

describe("AuthRepository", () => {
  it("creates unique local users and revocable opaque sessions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-auth-"),
    );
    try {
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

      const user = await repository.createLocalUser(
        "User@Example.test",
        "$argon2id$fake",
      );
      expect(user).not.toBeNull();
      await expect(
        repository.createLocalUser(
          "user@example.test",
          "$argon2id$other",
        ),
      ).resolves.toBeNull();
      await expect(
        repository.findLocalUser("USER@example.test"),
      ).resolves.toMatchObject({ id: user!.id });

      const handle = await repository.createSession(
        user!,
        [
          {
            scopeId: `user:${user!.id}`,
            permissions: ["read", "write"],
          },
        ],
        3_600,
        "local",
      );
      expect(handle.cookieValue).not.toContain("$argon2id$");
      await expect(
        repository.getSession(handle.cookieValue),
      ).resolves.toMatchObject({ userId: user!.id });

      await repository.revokeSession(handle.cookieValue);
      await expect(
        repository.getSession(handle.cookieValue),
      ).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("updates external tenant and role claims on later authentication", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-auth-claims-"),
    );
    try {
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

      const first = await repository.findOrCreateExternalUser({
        provider: "entra",
        issuer: "https://issuer.example",
        subject: "object-1",
        tenantId: "tenant-1",
        roles: ["reader"],
      });
      const second = await repository.findOrCreateExternalUser({
        provider: "entra",
        issuer: "https://issuer.example",
        subject: "object-1",
        tenantId: "tenant-1",
        roles: ["admin"],
      });

      expect(second.id).toBe(first.id);
      expect(second.roles).toEqual(["admin"]);
      expect(second.tenants).toEqual(["tenant-1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
