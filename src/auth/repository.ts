import type { JsonValue, ObjectStore } from "../core.js";
import {
  decodeJson,
  encodeJson,
  isPreconditionFailure,
} from "../shared-utils.js";
import type {
  AuthSession,
  AuthUser,
  ExternalIdentity,
  Identity,
  ScopeGrant,
} from "./types.js";

type IdentityIndex = {
  userId: string;
};

export type SessionHandle = {
  cookieValue: string;
  session: AuthSession;
};

export class AuthRepository {
  private static readonly DUMMY_USER_ID =
    "00000000-0000-0000-0000-000000000000";

  constructor(
    private readonly store: ObjectStore,
    private readonly indexValue: (
      value: string,
    ) => Promise<string> | string,
    private readonly digestValue: (
      value: string,
    ) => Promise<string> | string,
  ) {}

  async createLocalUser(
    login: string,
    passwordHash: string,
  ): Promise<AuthUser | null> {
    const normalised = normalizeLogin(login);
    const indexKey = await this.identityIndexKey(
      `local|${normalised}`,
    );
    const now = new Date().toISOString();
    const user: AuthUser = {
      id: crypto.randomUUID(),
      status: "active",
      authVersion: 1,
      identities: [
        { provider: "local", subject: normalised },
      ],
      roles: [],
      tenants: [],
      password: {
        encoded: passwordHash,
        changedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.putJson(this.userKey(user.id), user, {
        ifNoneMatch: true,
      });
      try {
        await this.putJson<IdentityIndex>(
          indexKey,
          { userId: user.id },
          { ifNoneMatch: true },
        );
        return user;
      } catch (error) {
        await this.store.delete(this.userKey(user.id));
        if (isPreconditionFailure(error)) {
          return null;
        }
        throw error;
      }
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return null;
      }
      throw error;
    }
  }

  async findLocalUser(login: string): Promise<AuthUser | null> {
    const normalised = normalizeLogin(login);
    return this.findByIdentity(`local|${normalised}`);
  }

  async findOrCreateExternalUser(
    identity: ExternalIdentity,
  ): Promise<AuthUser> {
    const identityValue = `${identity.provider}|${identity.issuer}|${identity.subject}`;
    const indexKey = await this.identityIndexKey(identityValue);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.findByIdentity(identityValue);
      if (existing) {
        return this.refreshExternalUser(existing.id, identity);
      }

      const user = externalUser(identity);
      await this.putJson(this.userKey(user.id), user, {
        ifNoneMatch: true,
      });
      try {
        await this.putJson<IdentityIndex>(
          indexKey,
          { userId: user.id },
          { ifNoneMatch: true },
        );
        return user;
      } catch (error) {
        await this.store.delete(this.userKey(user.id));
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        const raced = await this.waitForIdentityUser(identityValue);
        if (raced) {
          return this.refreshExternalUser(raced.id, identity);
        }
      }
    }
    throw new Error("External identity could not be provisioned");
  }

  async findExternalUser(
    identity: ExternalIdentity,
  ): Promise<AuthUser | null> {
    return this.findByIdentity(
      `${identity.provider}|${identity.issuer}|${identity.subject}`,
    );
  }

  getUser(userId: string): Promise<AuthUser | null> {
    return this.getJson<AuthUser>(this.userKey(userId));
  }

  async ensureDummyUser(): Promise<void> {
    const now = new Date(0).toISOString();
    const dummy: AuthUser = {
      id: AuthRepository.DUMMY_USER_ID,
      status: "disabled",
      authVersion: 0,
      identities: [
        {
          provider: "local",
          subject: "dummy",
        },
      ],
      roles: [],
      tenants: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.putJson(
        this.userKey(AuthRepository.DUMMY_USER_ID),
        dummy,
        { ifNoneMatch: true },
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
    }
  }

  readDummyUser(): Promise<AuthUser | null> {
    return this.getUser(AuthRepository.DUMMY_USER_ID);
  }

  async createSession(
    user: AuthUser,
    grants: ScopeGrant[],
    ttlSeconds: number,
    provider: Identity["provider"],
  ): Promise<SessionHandle> {
    const token = randomToken(32);
    const tokenDigest = await this.digestValue(token);
    const now = new Date();
    const session: AuthSession = {
      id: tokenDigest,
      userId: user.id,
      authVersion: user.authVersion,
      provider,
      csrfToken: randomToken(32),
      grants,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ttlSeconds * 1_000,
      ).toISOString(),
    };
    await this.putJson(
      this.sessionKey(user.id, tokenDigest),
      session,
      { ifNoneMatch: true },
    );
    return {
      cookieValue: `${user.id}.${token}`,
      session,
    };
  }

  async getSession(
    cookieValue: string,
  ): Promise<AuthSession | null> {
    const parsed = parseSessionCookieValue(cookieValue);
    if (!parsed) {
      return null;
    }
    const digest = await this.digestValue(parsed.token);
    const session = await this.getJson<AuthSession>(
      this.sessionKey(parsed.userId, digest),
    );
    if (!session) {
      return null;
    }
    if (session.expiresAt <= new Date().toISOString()) {
      await this.store.delete(
        this.sessionKey(parsed.userId, digest),
      );
      return null;
    }
    const user = await this.getUser(session.userId);
    if (
      !user ||
      user.status !== "active" ||
      user.authVersion !== session.authVersion
    ) {
      return null;
    }
    return session;
  }

  async revokeSession(cookieValue: string): Promise<void> {
    const parsed = parseSessionCookieValue(cookieValue);
    if (!parsed) {
      return;
    }
    const digest = await this.digestValue(parsed.token);
    await this.store.delete(
      this.sessionKey(parsed.userId, digest),
    );
  }

  async revokeAllSessions(userId: string): Promise<void> {
    const prefix = `sessions/${userId}/`;
    const keys = await this.store.list(prefix);
    await Promise.all(keys.map((key) => this.store.delete(key)));
  }

  async updatePassword(
    userId: string,
    encoded: string,
    expectedAuthVersion: number,
    expectedPasswordHash: string,
  ): Promise<AuthUser | null> {
    const key = this.userKey(userId);
    const object = await this.store.get(key);
    if (!object) {
      throw new Error(`User ${userId} is missing`);
    }
    const current = decodeJson<AuthUser>(object.bytes);
    if (
      current.authVersion !== expectedAuthVersion ||
      current.password?.encoded !== expectedPasswordHash
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const updated: AuthUser = {
      ...current,
      authVersion: current.authVersion + 1,
      password: {
        encoded,
        changedAt: now,
      },
      updatedAt: now,
    };
    try {
      await this.putJson(key, updated, {
        ifMatch: object.etag,
      });
      return updated;
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return null;
      }
      throw error;
    }
  }

  private async findByIdentity(
    identityValue: string,
  ): Promise<AuthUser | null> {
    const index = await this.getJson<IdentityIndex>(
      await this.identityIndexKey(identityValue),
    );
    return index ? this.getUser(index.userId) : null;
  }

  private async waitForIdentityUser(
    identityValue: string,
  ): Promise<AuthUser | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const user = await this.findByIdentity(identityValue);
      if (user) {
        return user;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  async refreshExternalUser(
    userId: string,
    identity: ExternalIdentity,
  ): Promise<AuthUser> {
    const key = this.userKey(userId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const object = await this.store.get(key);
      if (!object) {
        throw new Error(`External user ${userId} is missing`);
      }
      const current = decodeJson<AuthUser>(object.bytes);
      const tenants = identity.tenantId ? [identity.tenantId] : [];
      const roles = [...identity.roles].sort();
      if (
        sameStrings(current.tenants, tenants) &&
        sameStrings(current.roles, roles)
      ) {
        return current;
      }
      const updated: AuthUser = {
        ...current,
        tenants,
        roles,
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.putJson(key, updated, {
          ifMatch: object.etag,
        });
        return updated;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
      }
    }
    throw new Error(`External user ${userId} could not be updated`);
  }

  private identityIndexKey(
    identityValue: string,
  ): Promise<string> | string {
    const result = this.indexValue(identityValue);
    return result instanceof Promise
      ? result.then((hash) => `identities/${hash}.json`)
      : `identities/${result}.json`;
  }

  private userKey(userId: string): string {
    return `users/${userId}.json`;
  }

  private sessionKey(
    userId: string,
    digest: string,
  ): string {
    return `sessions/${userId}/${digest}.json`;
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const object = await this.store.get(key);
    return object ? decodeJson<T>(object.bytes) : null;
  }

  private putJson<T>(
    key: string,
    value: T,
    conditions?: {
      ifMatch?: string;
      ifNoneMatch?: boolean;
    },
  ): Promise<{ etag: string }> {
    return this.store.put(
      key,
      encodeJson(value as unknown as JsonValue),
      conditions,
    );
  }
}

export function normalizeLogin(login: string): string {
  const normalised = login.normalize("NFKC").trim().toLowerCase();
  if (
    normalised.length < 3 ||
    normalised.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(normalised)
  ) {
    throw new Error("Login identifier is invalid");
  }
  return normalised;
}

function parseSessionCookieValue(
  value: string,
): { userId: string; token: string } | null {
  const separator = value.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const userId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  return /^[0-9a-f-]{36}$/i.test(userId) && token.length >= 32
    ? { userId, token }
    : null;
}

function randomToken(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function externalUser(identity: ExternalIdentity): AuthUser {
  const now = new Date().toISOString();
  const storedIdentity: Identity =
    identity.provider === "entra"
      ? {
          provider: "entra",
          issuer: identity.issuer,
          subject: identity.subject,
          tenantId: identity.tenantId ?? "",
        }
      : {
          provider: "oidc",
          issuer: identity.issuer,
          subject: identity.subject,
        };
  return {
    id: crypto.randomUUID(),
    status: "active",
    authVersion: 1,
    identities: [storedIdentity],
    roles: [...identity.roles].sort(),
    tenants: identity.tenantId ? [identity.tenantId] : [],
    createdAt: now,
    updatedAt: now,
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
