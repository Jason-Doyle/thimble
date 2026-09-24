import type {
  AuthRateLimiter,
} from "./rate-limit.js";
import {
  findIdentity,
  type AuthRepository,
  type IdentityReference,
} from "./repository.js";
import type {
  AuthSession,
  AuthUser,
  ExternalIdentity,
  Identity,
  IdentityAdapter,
  Principal,
  ScopeAuthorizer,
} from "./types.js";

export class AuthService {
  constructor(
    private readonly options: {
      repository: AuthRepository;
      authorizer: ScopeAuthorizer;
      rateLimiter: AuthRateLimiter;
      identityAdapters?: Map<string, IdentityAdapter>;
      sessionTtlSeconds?: number;
      secureCookies?: boolean;
      recentAuthenticationSeconds?: number;
    },
  ) {}

  async loginExternal(
    adapterId: string,
    token: string,
    rateKey: string | null,
  ): Promise<AuthenticatedSession> {
    if (rateKey) {
      await this.requireRateLimit(
        `external-ip:${adapterId}:${rateKey}`,
      );
    }
    const identity = await this.authenticateAdapter(adapterId, token);
    await this.requireSubjectLimit(identity);
    const user =
      await this.options.repository.findOrCreateExternalUser(identity);
    if (!user || user.status !== "active") {
      throw invalidCredentials();
    }
    const storedIdentity = findIdentity(user, identity);
    if (!storedIdentity) {
      throw new Error(`Mapped user ${user.id} is missing its identity`);
    }
    return this.createSession(user, storedIdentity);
  }

  async authenticate(
    cookieValue: string | null,
  ): Promise<AuthenticatedSession | null> {
    if (!cookieValue) {
      return null;
    }
    const session =
      await this.options.repository.getSession(cookieValue);
    if (!session) {
      return null;
    }
    const user = await this.options.repository.getUser(session.userId);
    if (!user || user.status !== "active") {
      return null;
    }
    const principal = principalFor(user, session);
    const grants = await this.options.authorizer.grants(principal);
    return {
      user,
      session: {
        ...session,
        grants,
      },
      principal,
      cookieValue,
    };
  }

  logout(cookieValue: string | null): Promise<void> {
    return cookieValue
      ? this.options.repository.revokeSession(cookieValue)
      : Promise.resolve();
  }

  async linkIdentity(
    authenticated: AuthenticatedSession,
    adapterId: string,
    token: string,
    rateKey: string | null,
  ): Promise<AuthUser> {
    this.requireRecentAuthentication(authenticated.session);
    if (rateKey) {
      await this.requireRateLimit(
        `external-ip:${adapterId}:${rateKey}`,
      );
    }
    const identity = await this.authenticateAdapter(adapterId, token);
    await this.requireSubjectLimit(identity);
    const result =
      await this.options.repository.linkExternalIdentity(
        authenticated.user.id,
        identity,
      );
    if (result.status === "conflict") {
      throw new AuthError(
        409,
        "identity_conflict",
        "The external identity is already linked",
      );
    }
    return result.user;
  }

  async unlinkIdentity(
    authenticated: AuthenticatedSession,
    reference: IdentityReference,
  ): Promise<AuthUser> {
    this.requireRecentAuthentication(authenticated.session);
    const result =
      await this.options.repository.unlinkExternalIdentity(
        authenticated.user.id,
        reference,
      );
    if (result.status === "last_identity") {
      throw new AuthError(
        409,
        "last_identity",
        "The final external identity cannot be removed",
      );
    }
    if (result.status === "missing") {
      throw new AuthError(
        404,
        "identity_not_found",
        "External identity was not found",
      );
    }
    if (result.status === "concurrent") {
      throw new AuthError(
        409,
        "identity_changed",
        "The identity changed concurrently; retry with a fresh session",
      );
    }
    if (result.status !== "unlinked") {
      throw new Error("Unexpected identity unlink result");
    }
    return result.user;
  }

  async listUsers(
    authenticated: AuthenticatedSession,
  ): Promise<AuthUser[]> {
    requireAdministrator(authenticated);
    return this.options.repository.listUsers();
  }

  async administerUser(
    authenticated: AuthenticatedSession,
    userId: string,
    changes: {
      status?: AuthUser["status"];
      roles?: string[];
      tenants?: string[];
    },
  ): Promise<AuthUser> {
    requireAdministrator(authenticated);
    const user =
      await this.options.repository.updateAdministration(
        userId,
        changes,
      );
    if (!user) {
      throw new AuthError(404, "user_not_found", "User was not found");
    }
    return user;
  }

  async revokeUserSessions(
    authenticated: AuthenticatedSession,
    userId: string,
  ): Promise<void> {
    requireAdministrator(authenticated);
    const user = await this.options.repository.getUser(userId);
    if (!user) {
      throw new AuthError(404, "user_not_found", "User was not found");
    }
    await this.options.repository.revokeAllSessions(userId);
  }

  sessionCookie(cookieValue: string): string {
    return [
      `${this.cookieName()}=${cookieValue}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${this.options.sessionTtlSeconds ?? 3_600}`,
      this.options.secureCookies ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  clearSessionCookie(): string {
    return [
      `${this.cookieName()}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
      this.options.secureCookies ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  cookieName(): string {
    return this.options.secureCookies
      ? "__Host-thimble_session"
      : "thimble_session";
  }

  requireCsrf(
    expected: string,
    provided: string | null,
  ): void {
    if (!provided || !constantTimeTextEqual(expected, provided)) {
      throw new AuthError(403, "csrf_failed", "Request was rejected");
    }
  }

  private async createSession(
    user: AuthUser,
    identity: Identity,
  ): Promise<AuthenticatedSession> {
    const principal = principalFor(user, identity);
    const grants = await this.options.authorizer.grants(principal);
    const handle = await this.options.repository.createSession(
      user,
      grants,
      this.options.sessionTtlSeconds ?? 3_600,
      identity,
    );
    return {
      user,
      principal,
      session: handle.session,
      cookieValue: handle.cookieValue,
    };
  }

  private async requireRateLimit(key: string): Promise<void> {
    const result = await this.options.rateLimiter.consume(key);
    this.throwIfLimited(result);
  }

  private async authenticateAdapter(
    adapterId: string,
    token: string,
  ): Promise<ExternalIdentity> {
    const adapter = this.options.identityAdapters?.get(adapterId);
    if (!adapter) {
      throw invalidCredentials();
    }
    const identity = await adapter.authenticate(token);
    if (!identity) {
      throw invalidCredentials();
    }
    return identity;
  }

  private requireSubjectLimit(
    identity: ExternalIdentity,
  ): Promise<void> {
    return this.requireRateLimit(
      `external-subject:${identity.issuer}|${identity.subject}`,
    );
  }

  private requireRecentAuthentication(session: AuthSession): void {
    const maximumAge =
      (this.options.recentAuthenticationSeconds ?? 600) * 1_000;
    if (
      Date.now() - new Date(session.createdAt).getTime() >
      maximumAge
    ) {
      throw new AuthError(
        401,
        "recent_authentication_required",
        "Authenticate again before changing linked identities",
      );
    }
  }

  private throwIfLimited(
    result: Awaited<ReturnType<AuthRateLimiter["consume"]>>,
  ): void {
    if (!result.allowed) {
      throw new AuthError(
        429,
        "rate_limited",
        "Try again later",
        result.retryAfterSeconds,
      );
    }
  }

}

export type AuthenticatedSession = {
  user: AuthUser;
  principal: Principal;
  session: AuthSession;
  cookieValue: string;
};

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function principalFor(
  user: AuthUser,
  reference: Pick<
    Identity,
    "provider" | "issuer" | "subject"
  >,
): Principal {
  if (
    reference.provider !== "entra" &&
    reference.provider !== "oidc"
  ) {
    throw new Error(
      `Unsupported identity provider: ${String(reference.provider)}`,
    );
  }
  const identity = findIdentity(user, reference);
  if (!identity) {
    throw new Error(`User ${user.id} has no matching identity`);
  }
  return {
    userId: user.id,
    authVersion: user.authVersion,
    provider: identity.provider,
    issuer: identity.issuer,
    subject: identity.subject,
    tenantIds: sortedUnique([
      ...user.tenants,
      ...identity.tenants,
    ]),
    roles: sortedUnique([
      ...user.roles,
      ...identity.roles,
    ]),
  };
}

function requireAdministrator(
  authenticated: AuthenticatedSession,
): void {
  if (!authenticated.principal.roles.includes("thimble.admin")) {
    throw new AuthError(403, "administrator_required", "Access denied");
  }
}

function invalidCredentials(): AuthError {
  return new AuthError(
    401,
    "invalid_credentials",
    "Invalid external credentials",
  );
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
