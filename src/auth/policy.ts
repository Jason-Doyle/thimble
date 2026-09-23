import type {
  Principal,
  ScopeAuthorizer,
  ScopeGrant,
} from "./types.js";

export class DefaultScopeAuthorizer implements ScopeAuthorizer {
  constructor(
    private readonly tenantWriterRoles = new Set([
      "thimble.tenant.writer",
      "thimble.tenant.admin",
    ]),
    private readonly tenantAdminRoles = new Set([
      "thimble.tenant.admin",
    ]),
  ) {}

  async grants(principal: Principal): Promise<ScopeGrant[]> {
    const grants: ScopeGrant[] = [
      {
        scopeId: `user:${principal.userId}`,
        permissions: ["read", "write"],
      },
    ];

    for (const tenantId of principal.tenantIds) {
      const permissions: ScopeGrant["permissions"] = ["read"];
      if (
        principal.roles.some((role) =>
          this.tenantWriterRoles.has(role),
        )
      ) {
        permissions.push("write");
      }
      if (
        principal.roles.some((role) =>
          this.tenantAdminRoles.has(role),
        )
      ) {
        permissions.push("admin");
      }
      grants.push({
        scopeId: `tenant:${tenantId}`,
        permissions,
      });
    }

    for (const role of principal.roles) {
      grants.push({
        scopeId: `role:${role}`,
        permissions: ["read"],
      });
    }

    return grants;
  }
}
