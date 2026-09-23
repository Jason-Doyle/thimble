import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  createLocalJWKSet,
} from "jose";
import { describe, expect, it } from "vitest";
import { OidcIdentityAdapter } from "../src/auth/oidc.js";

describe("OidcIdentityAdapter", () => {
  it("maps Entra identities by tenant and object id, not email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    const issuer =
      "https://login.microsoftonline.com/tenant-1/v2.0";
    const token = await new SignJWT({
      oid: "object-1",
      tid: "tenant-1",
      email: "mutable@example.test",
      roles: ["reader"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("api-client")
      .setSubject("different-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const adapter = new OidcIdentityAdapter({
      id: "entra",
      issuer,
      audience: "api-client",
      jwksUri: "https://unused.example.test/keys",
      allowedTenants: ["tenant-1"],
      provider: "entra",
      keySet: createLocalJWKSet({ keys: [publicJwk] }),
    });

    await expect(adapter.authenticate(token)).resolves.toMatchObject({
      provider: "entra",
      issuer,
      subject: "object-1",
      tenantId: "tenant-1",
      roles: ["reader"],
    });
  });

  it("rejects tokens from an unapproved tenant", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "key";
    jwk.alg = "RS256";
    const issuer =
      "https://login.microsoftonline.com/tenant-2/v2.0";
    const token = await new SignJWT({
      oid: "object-2",
      tid: "tenant-2",
    })
      .setProtectedHeader({ alg: "RS256", kid: "key" })
      .setIssuer(issuer)
      .setAudience("api-client")
      .setExpirationTime("5m")
      .sign(privateKey);
    const adapter = new OidcIdentityAdapter({
      id: "entra",
      issuer,
      audience: "api-client",
      jwksUri: "https://unused.example.test/keys",
      allowedTenants: ["tenant-1"],
      provider: "entra",
      keySet: createLocalJWKSet({ keys: [jwk] }),
    });

    await expect(adapter.authenticate(token)).resolves.toBeNull();
  });
});
