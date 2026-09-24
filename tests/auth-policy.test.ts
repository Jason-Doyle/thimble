import { describe, expect, it } from "vitest";
import { DefaultScopeAuthorizer } from "../src/auth/policy.js";

describe("DefaultScopeAuthorizer", () => {
  it("does not grant tenant writes without an explicit writer role", async () => {
    const authorizer = new DefaultScopeAuthorizer();
    const grants = await authorizer.grants({
      userId: "user-1",
      authVersion: 1,
      provider: "entra",
      issuer: "https://issuer.example",
      subject: "object-1",
      tenantIds: ["tenant-1"],
      roles: [],
    });

    expect(grants).toContainEqual({
      scopeId: "tenant:tenant-1",
      permissions: ["read"],
    });
  });

  it("grants tenant writes only to the configured role", async () => {
    const authorizer = new DefaultScopeAuthorizer();
    const grants = await authorizer.grants({
      userId: "user-1",
      authVersion: 1,
      provider: "entra",
      issuer: "https://issuer.example",
      subject: "object-1",
      tenantIds: ["tenant-1"],
      roles: ["thimble.tenant.writer"],
    });

    expect(grants).toContainEqual({
      scopeId: "tenant:tenant-1",
      permissions: ["read", "write"],
    });
  });
});
