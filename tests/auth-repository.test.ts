import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthRepository } from "../src/auth/repository.js";
import type { ExternalIdentity } from "../src/auth/types.js";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import { importAesGcmKey } from "../src/envelope.js";
import { LocalObjectStore } from "../src/stores.js";

describe("AuthRepository", () => {
  it("maps an external identity to a stable user and revocable session", async () => {
    const fixture = await repositoryFixture("session");
    try {
      const identity = externalIdentity();
      const user =
        await fixture.repository.findOrCreateExternalUser(identity);
      const found =
        await fixture.repository.findExternalUser(identity);
      expect(found?.id).toBe(user.id);

      const handle = await fixture.repository.createSession(
        user,
        [
          {
            scopeId: `user:${user.id}`,
            permissions: ["read", "write"],
          },
        ],
        3_600,
        user.identities[0]!,
      );
      await expect(
        fixture.repository.getSession(handle.cookieValue),
      ).resolves.toMatchObject({ userId: user.id });

      await fixture.repository.revokeSession(handle.cookieValue);
      await expect(
        fixture.repository.getSession(handle.cookieValue),
      ).resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("updates external tenant and role claims on later authentication", async () => {
    const fixture = await repositoryFixture("claims");
    try {
      const first =
        await fixture.repository.findOrCreateExternalUser(
          externalIdentity(["reader"]),
        );
      const second =
        await fixture.repository.findOrCreateExternalUser(
          externalIdentity(["admin"]),
        );

      expect(second.id).toBe(first.id);
        expect(second.roles).toEqual([]);
        expect(second.tenants).toEqual([]);
        expect(second.identities[0]).toMatchObject({
          roles: ["admin"],
          tenants: ["tenant-1"],
        });
    } finally {
      await fixture.cleanup();
    }
  });

  it("recovers when the same external identity is provisioned concurrently", async () => {
    const fixture = await repositoryFixture("race");
    try {
      const identity = externalIdentity();
      const [first, second] = await Promise.all([
        fixture.repository.findOrCreateExternalUser(identity),
        fixture.repository.findOrCreateExternalUser(identity),
      ]);

      expect(second.id).toBe(first.id);
      await expect(
        fixture.repository.findExternalUser(identity),
      ).resolves.toMatchObject({ id: first.id });
    } finally {
      await fixture.cleanup();
    }
  });
});

async function repositoryFixture(label: string): Promise<{
  repository: AuthRepository;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `thimbledb-auth-${label}-`),
  );
  const key = await importAesGcmKey(
    crypto.getRandomValues(new Uint8Array(32)),
    ["encrypt", "decrypt"],
  );
  const indexKey = crypto.getRandomValues(new Uint8Array(32));
  return {
    repository: new AuthRepository(
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
    ),
    cleanup: () =>
      rm(directory, { recursive: true, force: true }),
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
