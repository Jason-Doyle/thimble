import {
  createRemoteJWKSet,
  errors,
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
  requiredScopes?: string[];
  requiredRoles?: string[];
};

export class OidcIdentityAdapter implements IdentityAdapter {
  readonly id: string;
  private readonly jwks;

  constructor(private readonly options: OidcAdapterOptions) {
    if (
      !options.requiredScopes?.length &&
      !options.requiredRoles?.length
    ) {
      throw new Error(
        `OIDC adapter ${options.id} requires at least one scope or role`,
      );
    }
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
    } catch (error) {
      if (isRejectedToken(error)) {
        return null;
      }
      throw error;
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
    const scopes = scopeClaim(payload);
    const roles = stringArrayClaim(payload, "roles");
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
    if (
      this.options.requiredScopes?.length &&
      !this.options.requiredScopes.some((scope) =>
        scopes.includes(scope),
      )
    ) {
      return null;
    }
    if (
      this.options.requiredRoles?.length &&
      !this.options.requiredRoles.some((role) =>
        roles.includes(role),
      )
    ) {
      return null;
    }
    return {
      provider: this.options.provider ?? "oidc",
      issuer: this.options.issuer,
      subject,
      ...(tenantId ? { tenantId } : {}),
      roles,
      scopes,
      ...(typeof payload.name === "string"
        ? { displayName: payload.name }
        : {}),
    };
  }
}

function isRejectedToken(error: unknown): boolean {
  return (
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTExpired ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JWSSignatureVerificationFailed
  );
}

export function createEntraAdapter(options: {
  tenantId: string;
  audience: string;
  requiredScope?: string;
  requiredRole?: string;
}): OidcIdentityAdapter {
  const issuer = `https://login.microsoftonline.com/${options.tenantId}/v2.0`;
  return new OidcIdentityAdapter({
    id: "entra",
    issuer,
    audience: options.audience,
    jwksUri: `https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`,
    allowedTenants: [options.tenantId],
    provider: "entra",
    ...(options.requiredScope
      ? { requiredScopes: [options.requiredScope] }
      : {}),
    ...(options.requiredRole
      ? { requiredRoles: [options.requiredRole] }
      : {}),
  });
}

function scopeClaim(payload: JWTPayload): string[] {
  const value = payload.scp;
  return typeof value === "string"
    ? value.split(/\s+/).filter(Boolean)
    : [];
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
