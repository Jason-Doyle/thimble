import type {
  Principal,
  ScopeAuthorizer,
  ScopeGrant,
} from "./types.js";

export class DefaultScopeAuthorizer implements ScopeAuthorizer {
  async grants(principal: Principal): Promise<ScopeGrant[]> {
    const grants: ScopeGrant[] = [
      {
        scopeId: `user:${principal.userId}`,
        permissions: ["read", "write"],
      },
    ];

    for (const tenantId of principal.tenantIds) {
      grants.push({
        scopeId: `tenant:${tenantId}`,
        permissions: ["read", "write"],
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
