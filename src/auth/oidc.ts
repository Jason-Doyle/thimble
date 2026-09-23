import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type {
  ExternalIdentity,
  IdentityAdapter,
} from "./types.js";

export type OidcAdapterOptions = {
  id: string;
  issuer: string;
  audience: string;
  jwksUri: string;
  allowedTenants?: string[];
  provider?: "entra" | "oidc";
  keySet?: JWTVerifyGetKey;
};

export class OidcIdentityAdapter implements IdentityAdapter {
  readonly id: string;
  private readonly jwks;

  constructor(private readonly options: OidcAdapterOptions) {
    this.id = options.id;
    this.jwks =
      options.keySet ??
      createRemoteJWKSet(new URL(options.jwksUri));
  }

  async authenticate(
    token: string,
  ): Promise<ExternalIdentity | null> {
    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      return this.identity(verified.payload);
    } catch {
      return null;
    }
  }

  private identity(payload: JWTPayload): ExternalIdentity | null {
    if (typeof payload.exp !== "number") {
      return null;
    }
    const subject =
      this.options.provider === "entra"
        ? stringClaim(payload, "oid")
        : payload.sub;
    const tenantId = stringClaim(payload, "tid");
    if (!subject) {
      return null;
    }
    if (
      this.options.allowedTenants?.length &&
      (!tenantId ||
        !this.options.allowedTenants.includes(tenantId))
    ) {
      return null;
    }
    return {
      provider: this.options.provider ?? "oidc",
      issuer: this.options.issuer,
      subject,
      ...(tenantId ? { tenantId } : {}),
      roles: stringArrayClaim(payload, "roles"),
      ...(typeof payload.name === "string"
        ? { displayName: payload.name }
        : {}),
    };
  }
}

export function createEntraAdapter(options: {
  tenantId: string;
  audience: string;
}): OidcIdentityAdapter {
  const issuer = `https://login.microsoftonline.com/${options.tenantId}/v2.0`;
  return new OidcIdentityAdapter({
    id: "entra",
    issuer,
    audience: options.audience,
    jwksUri: `https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`,
    allowedTenants: [options.tenantId],
    provider: "entra",
  });
}

function stringClaim(
  payload: JWTPayload,
  name: string,
): string | undefined {
  const value = payload[name];
  return typeof value === "string" ? value : undefined;
}

function stringArrayClaim(
  payload: JWTPayload,
  name: string,
): string[] {
  const value = payload[name];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
}
