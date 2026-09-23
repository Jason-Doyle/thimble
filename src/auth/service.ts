import type {
  AuthRateLimiter,
} from "./rate-limit.js";
import type { PasswordHasher } from "./password.js";
import type { AuthRepository } from "./repository.js";
import type {
  AuthSession,
  AuthUser,
  IdentityAdapter,
  Principal,
  ScopeAuthorizer,
} from "./types.js";

export class AuthService {
  constructor(
    private readonly options: {
      repository: AuthRepository;
      passwords: PasswordHasher;
      authorizer: ScopeAuthorizer;
      rateLimiter: AuthRateLimiter;
      identityAdapters?: Map<string, IdentityAdapter>;
      registrationEnabled?: boolean;
      sessionTtlSeconds?: number;
      secureCookies?: boolean;
      minimumLoginDurationMs?: number;
    },
  ) {}

  async register(
    login: string,
    password: string,
    rateKey: string,
  ): Promise<void> {
    if (!this.options.registrationEnabled) {
      throw new AuthError(
        404,
        "registration_disabled",
        "Registration is unavailable",
      );
    }
    await this.requireRateLimit(`register:${rateKey}`);
    let hash: string;
    try {
      hash = await this.options.passwords.hash(password);
    } catch {
      throw new AuthError(
        400,
        "invalid_password",
        "Password does not meet the configured policy",
      );
    }
    await this.options.repository.createLocalUser(login, hash);
  }

  async login(
    login: string,
    password: string,
    rateKey: string,
  ): Promise<AuthenticatedSession> {
    const started = performance.now();
    await this.requireRateLimit(`login-ip:${rateKey}`);
    await this.requireRateLimit(
      `login-account:${await digestText(
        login.normalize("NFKC").trim().toLowerCase(),
      )}`,
    );

    const user = await this.options.repository.findLocalUser(login);
    const valid =
      user?.password &&
      (await this.options.passwords.verify(
        password,
        user.password.encoded,
      ));
    if (!user || !valid || user.status !== "active") {
      if (!user) {
        await this.options.repository.readDummyUser();
        await this.options.passwords.runDummyVerification(password);
      }
      await this.finishLoginDelay(started);
      throw invalidCredentials();
    }
    await this.finishLoginDelay(started);
    return this.createSession(user, "local");
  }

  async loginExternal(
    adapterId: string,
    token: string,
    rateKey: string,
  ): Promise<AuthenticatedSession> {
    await this.requireRateLimit(`external:${adapterId}:${rateKey}`);
    const adapter = this.options.identityAdapters?.get(adapterId);
    if (!adapter) {
      throw invalidCredentials();
    }
    const identity = await adapter.authenticate(token);
    if (!identity) {
      throw invalidCredentials();
    }
    const user =
      await this.options.repository.findOrCreateExternalUser(identity);
    if (user.status !== "active") {
      throw invalidCredentials();
    }
    return this.createSession(user, identity.provider);
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
    const principal = principalFor(user, session.provider);
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
    provider: Principal["provider"],
  ): Promise<AuthenticatedSession> {
    const principal = principalFor(user, provider);
    const grants = await this.options.authorizer.grants(principal);
    const handle = await this.options.repository.createSession(
      user,
      grants,
      this.options.sessionTtlSeconds ?? 3_600,
      provider,
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
    if (!result.allowed) {
      throw new AuthError(
        429,
        "rate_limited",
        "Try again later",
        result.retryAfterSeconds,
      );
    }
  }

  private async finishLoginDelay(started: number): Promise<void> {
    const minimum = this.options.minimumLoginDurationMs ?? 250;
    const remaining = minimum - (performance.now() - started);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
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
  provider: Principal["provider"],
): Principal {
  const identity =
    user.identities.find((item) => item.provider === provider) ??
    user.identities[0];
  if (!identity) {
    throw new Error(`User ${user.id} has no identity`);
  }
  return {
    userId: user.id,
    authVersion: user.authVersion,
    provider: identity.provider,
    subject: identity.subject,
    tenantIds: [...user.tenants],
    roles: [...user.roles],
  };
}

function invalidCredentials(): AuthError {
  return new AuthError(
    401,
    "invalid_credentials",
    "Invalid login or password",
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

async function digestText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
