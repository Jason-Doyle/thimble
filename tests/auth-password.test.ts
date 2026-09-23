import { describe, expect, it } from "vitest";
import { PasswordHasher } from "../src/auth/password.js";

describe("PasswordHasher", () => {
  it("stores Argon2id hashes and verifies the exact password", async () => {
    const hasher = new PasswordHasher(
      crypto.getRandomValues(new Uint8Array(32)),
      {
        memorySizeKiB: 1_024,
        iterations: 2,
      },
    );
    const encoded = await hasher.hash("correct horse battery staple");

    expect(encoded).toContain("$argon2id$");
    await expect(
      hasher.verify("correct horse battery staple", encoded),
    ).resolves.toBe(true);
    await expect(
      hasher.verify("wrong password", encoded),
    ).resolves.toBe(false);
  });

  it("rejects short passwords", async () => {
    const hasher = new PasswordHasher(
      crypto.getRandomValues(new Uint8Array(32)),
      { memorySizeKiB: 1_024 },
    );
    await expect(hasher.hash("short")).rejects.toThrow(
      "at least 12",
    );
  });
});
