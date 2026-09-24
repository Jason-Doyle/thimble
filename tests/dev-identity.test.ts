import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_IDENTITY_TOKEN,
  DevelopmentIdentityAdapter,
  validateDevelopmentIdentity,
} from "../src/auth/dev-identity.js";

describe("development identity", () => {
  it("authenticates only the internal development token", async () => {
    const adapter = new DevelopmentIdentityAdapter();

    await expect(adapter.authenticate("wrong")).resolves.toBeNull();
    await expect(
      adapter.authenticate(DEVELOPMENT_IDENTITY_TOKEN),
    ).resolves.toMatchObject({
      provider: "oidc",
      issuer: "urn:thimbledb:development",
      subject: "local-developer",
      roles: ["thimble.user", "thimble.admin"],
    });
  });

  it("permits only loopback local non-production configuration", () => {
    expect(
      validateDevelopmentIdentity({
        enabled: true,
        provider: "local",
        host: "127.0.0.1",
        allowedOrigin: "http://localhost:5173",
      }),
    ).toBe(true);

    expect(() =>
      validateDevelopmentIdentity({
        enabled: true,
        nodeEnvironment: "production",
        provider: "local",
        host: "127.0.0.1",
        allowedOrigin: "http://127.0.0.1:5173",
      }),
    ).toThrow("cannot be enabled in production");
    expect(() =>
      validateDevelopmentIdentity({
        enabled: true,
        provider: "s3",
        host: "127.0.0.1",
        allowedOrigin: "http://127.0.0.1:5173",
      }),
    ).toThrow("requires THIMBLE_PROVIDER=local");
    expect(() =>
      validateDevelopmentIdentity({
        enabled: true,
        provider: "local",
        host: "0.0.0.0",
        allowedOrigin: "http://127.0.0.1:5173",
      }),
    ).toThrow("requires a loopback THIMBLE_HOST");
    expect(() =>
      validateDevelopmentIdentity({
        enabled: true,
        provider: "local",
        host: "127.0.0.1",
        allowedOrigin: "https://app.example.com",
      }),
    ).toThrow("requires a loopback THIMBLE_ALLOWED_ORIGIN");
  });

  it("stays disabled without the explicit flag", () => {
    expect(
      validateDevelopmentIdentity({
        enabled: false,
        nodeEnvironment: "production",
        provider: "s3",
        host: "0.0.0.0",
        allowedOrigin: "https://app.example.com",
      }),
    ).toBe(false);
  });
});
