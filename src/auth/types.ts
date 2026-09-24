export type Identity =
  | {
      provider: "entra";
      issuer: string;
      subject: string;
      tenantId: string;
      roles: string[];
      tenants: string[];
    }
  | {
      provider: "oidc";
      issuer: string;
      subject: string;
      roles: string[];
      tenants: string[];
    };

export type AuthUser = {
  id: string;
  status: "active" | "disabled";
  authVersion: number;
  identities: Identity[];
  roles: string[];
  tenants: string[];
  createdAt: string;
  updatedAt: string;
};

export type Principal = {
  userId: string;
  authVersion: number;
  provider: Identity["provider"];
  issuer: string;
  subject: string;
  tenantIds: string[];
  roles: string[];
};

export type ScopeGrant = {
  scopeId: string;
  permissions: Array<"read" | "write" | "admin">;
};

export type AuthSession = {
  id: string;
  userId: string;
  authVersion: number;
  provider: Identity["provider"];
  issuer: string;
  subject: string;
  csrfToken: string;
  grants: ScopeGrant[];
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export interface IdentityAdapter {
  readonly id: string;
  authenticate(token: string): Promise<ExternalIdentity | null>;
}

export type ExternalIdentity = {
  provider: "entra" | "oidc";
  issuer: string;
  subject: string;
  tenantId?: string;
  roles: string[];
  scopes: string[];
  displayName?: string;
};

export interface ScopeAuthorizer {
  grants(
    principal: Principal,
    action?: "read" | "write" | "admin",
  ): Promise<ScopeGrant[]>;
}
