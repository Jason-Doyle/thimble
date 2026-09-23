import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeLegacyLocalAuth } from "../src/auth/legacy-migration.js";
import { AuthRepository } from "../src/auth/repository.js";
import type { JsonValue } from "../src/core.js";
import { decodeJson, encodeJson } from "../src/shared-utils.js";
import { LocalObjectStore } from "../src/stores.js";

describe("legacy local-auth migration", () => {
  it("rejects persisted local-provider sessions before migration", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-local-session-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const userId = "11111111-1111-4111-8111-111111111111";
      const token = "a".repeat(43);
      const digest = createHash("sha256")
        .update(token)
        .digest("hex");
      await store.put(
        `sessions/${userId}/${digest}.json`,
        encodeJson({
          id: digest,
          userId,
          authVersion: 1,
          provider: "local",
          csrfToken: "csrf",
          grants: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        } as unknown as JsonValue),
      );
      const repository = new AuthRepository(
        store,
        (value) =>
          createHash("sha256").update(value).digest("hex"),
        (value) =>
          createHash("sha256").update(value).digest("hex"),
      );

      await expect(
        repository.getSession(`${userId}.${token}`),
      ).resolves.toBeNull();
      expect(
        await store.get(`sessions/${userId}/${digest}.json`),
      ).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the user UUID while removing credentials and sessions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-local-auth-migration-"),
    );
    try {
      const store = new LocalObjectStore(directory);
      const userId = "11111111-1111-4111-8111-111111111111";
      const subject = "person@example.test";
      const index = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      await store.put(
        `users/${userId}.json`,
        encodeJson({
          id: userId,
          status: "active",
          authVersion: 1,
          identities: [{ provider: "local", subject }],
          roles: [],
          tenants: [],
          password: {
            encoded: "$argon2id$legacy",
            changedAt: "2026-01-01T00:00:00.000Z",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as unknown as JsonValue),
      );
      const identityKey = `identities/${index(`local|${subject}`)}.json`;
      await store.put(
        identityKey,
        encodeJson({ userId } as unknown as JsonValue),
      );
      await store.put(
        `sessions/${userId}/legacy.json`,
        encodeJson({ userId } as unknown as JsonValue),
      );

      await expect(
        removeLegacyLocalAuth(store, index),
      ).resolves.toEqual({
        usersSanitized: 1,
        sessionsRevoked: 1,
        identityIndexesRemoved: 1,
      });

      const migrated = decodeJson<Record<string, unknown>>(
        (await store.get(`users/${userId}.json`))!.bytes,
      );
      expect(migrated).toMatchObject({
        id: userId,
        status: "disabled",
        authVersion: 2,
        identities: [],
      });
      expect(migrated).not.toHaveProperty("password");
      expect(await store.get(identityKey)).toBeNull();
      expect(await store.list(`sessions/${userId}/`)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
