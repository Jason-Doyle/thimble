import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  createLocalJWKSet,
} from "jose";
import { describe, expect, it } from "vitest";
import { OidcIdentityAdapter } from "../src/auth/oidc.js";

describe("OidcIdentityAdapter", () => {
  it("maps generic OIDC identities by issuer and subject", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "generic-key";
    publicJwk.alg = "RS256";
    const issuer = "https://identity.example.test";
    const token = await new SignJWT({
      scope: "thimble.access",
      roles: ["catalogue.reader"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "generic-key" })
      .setIssuer(issuer)
      .setAudience("thimbledb-api")
      .setSubject("provider-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const adapter = new OidcIdentityAdapter({
      id: "generic",
      issuer,
      audience: "thimbledb-api",
      jwksUri: "https://unused.example.test/keys",
      requiredScopes: ["thimble.access"],
      keySet: createLocalJWKSet({ keys: [publicJwk] }),
    });

    await expect(adapter.authenticate(token)).resolves.toMatchObject({
      provider: "oidc",
      issuer,
      subject: "provider-user-1",
      roles: ["catalogue.reader"],
      scopes: ["thimble.access"],
    });
  });

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
      scp: "thimble.read",
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
      requiredScopes: ["thimble.read"],
      keySet: createLocalJWKSet({ keys: [publicJwk] }),
    });

    await expect(adapter.authenticate(token)).resolves.toMatchObject({
      provider: "entra",
      issuer,
      subject: "object-1",
      tenantId: "tenant-1",
      roles: ["reader"],
      scopes: ["thimble.read"],
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
      requiredRoles: ["reader"],
      keySet: createLocalJWKSet({ keys: [jwk] }),
    });

    await expect(adapter.authenticate(token)).resolves.toBeNull();
  });

  it("rejects a valid audience token without the required scope or role", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "claim-key";
    jwk.alg = "RS256";
    const issuer =
      "https://login.microsoftonline.com/tenant-1/v2.0";
    const token = await new SignJWT({
      oid: "object-3",
      tid: "tenant-1",
      scp: "other.scope",
      roles: ["Other.Role"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "claim-key" })
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
      requiredScopes: ["thimble.read"],
      keySet: createLocalJWKSet({ keys: [jwk] }),
    });

    await expect(adapter.authenticate(token)).resolves.toBeNull();
  });

  it("surfaces identity-provider key retrieval failures", async () => {
    const adapter = new OidcIdentityAdapter({
      id: "entra",
      issuer:
        "https://login.microsoftonline.com/tenant-1/v2.0",
      audience: "api-client",
      jwksUri: "https://unused.example.test/keys",
      provider: "entra",
      requiredScopes: ["thimble.read"],
      keySet: async () => {
        throw new Error("identity provider unavailable");
      },
    });

    await expect(
      adapter.authenticate(
        "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleSJ9.eyJleHAiOjQxMDI0NDQ4MDB9.signature",
      ),
    ).rejects.toThrow("identity provider unavailable");
  });
});
