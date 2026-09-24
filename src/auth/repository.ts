import type {
  JsonValue,
  ObjectStore,
  StoredObject,
} from "../core.js";
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
  linked?: boolean;
  nonce?: string;
};

export type SessionHandle = {
  cookieValue: string;
  session: AuthSession;
};

export type IdentityReference = Pick<
  Identity,
  "provider" | "issuer" | "subject"
>;

export type LinkIdentityResult =
  | { status: "linked"; user: AuthUser }
  | { status: "conflict" };

export type UnlinkIdentityResult =
  | { status: "unlinked"; user: AuthUser }
  | { status: "missing" | "last_identity" | "concurrent" };

export class AuthRepository {
  constructor(
    private readonly store: ObjectStore,
    private readonly indexValue: (
      value: string,
    ) => Promise<string> | string,
    private readonly digestValue: (
      value: string,
    ) => Promise<string> | string,
  ) {}

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
        const index = await this.loadIdentityIndex(indexKey);
        if (index?.value.linked !== false) {
          if (index) {
            throw new Error("identity_index_active");
          }
          await this.putJson<IdentityIndex>(
            indexKey,
            {
              userId: user.id,
              linked: true,
              nonce: randomToken(16),
            },
            { ifNoneMatch: true },
          );
        } else {
          await this.putJson<IdentityIndex>(
            indexKey,
            {
              userId: user.id,
              linked: true,
              nonce: randomToken(16),
            },
            { ifMatch: index.object.etag },
          );
        }
        return user;
      } catch (error) {
        await this.store.delete(this.userKey(user.id));
        if (
          !isPreconditionFailure(error) &&
          !(
            error instanceof Error &&
            error.message === "identity_index_active"
          )
        ) {
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
    return this.getExternalUser(this.userKey(userId));
  }

  async listUsers(): Promise<AuthUser[]> {
    const users = await Promise.all(
      (await this.store.list("users/")).map((key) =>
        this.getExternalUser(key),
      ),
    );
    return users
      .filter((user): user is AuthUser => user !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createSession(
    user: AuthUser,
    grants: ScopeGrant[],
    ttlSeconds: number,
    identity: Identity,
  ): Promise<SessionHandle> {
    const token = randomToken(32);
    const tokenDigest = await this.digestValue(token);
    const now = new Date();
    const session: AuthSession = {
      id: tokenDigest,
      userId: user.id,
      authVersion: user.authVersion,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
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
    if (
      !isExternalProvider(session.provider) ||
      typeof session.issuer !== "string" ||
      typeof session.subject !== "string"
    ) {
      await this.store.delete(
        this.sessionKey(parsed.userId, digest),
      );
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
      user.authVersion !== session.authVersion ||
      !findIdentity(user, session)
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

  async linkExternalIdentity(
    userId: string,
    identity: ExternalIdentity,
  ): Promise<LinkIdentityResult> {
    const identityValue = identityValueFor(identity);
    const indexKey = await this.identityIndexKey(identityValue);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const index = await this.loadIdentityIndex(indexKey);
      if (
        index &&
        index.value.linked !== false &&
        index.value.userId !== userId
      ) {
        return { status: "conflict" };
      }
      if (index) {
        try {
          await this.putJson<IdentityIndex>(
            indexKey,
            {
              userId,
              linked: true,
              nonce: randomToken(16),
            },
            { ifMatch: index.object.etag },
          );
        } catch (error) {
          if (isPreconditionFailure(error)) {
            continue;
          }
          throw error;
        }
      } else {
        try {
          await this.putJson<IdentityIndex>(
            indexKey,
            {
              userId,
              linked: true,
              nonce: randomToken(16),
            },
            { ifNoneMatch: true },
          );
        } catch (error) {
          if (isPreconditionFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      const key = this.userKey(userId);
      const object = await this.store.get(key);
      if (!object) {
        await this.store.delete(indexKey);
        throw new Error(`External user ${userId} is missing`);
      }
      const current = normaliseExternalAuthUser(
        decodeJson<unknown>(object.bytes),
      );
      if (!current) {
        throw new Error(`External user ${userId} is invalid`);
      }
      if (findIdentity(current, identity)) {
        return {
          status: "linked",
          user: await this.refreshExternalUser(userId, identity),
        };
      }
      const updated: AuthUser = {
        ...current,
        identities: [
          ...current.identities,
          storedIdentity(identity),
        ],
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.putJson(key, updated, {
          ifMatch: object.etag,
        });
        return { status: "linked", user: updated };
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
      }
    }
    throw new Error(`External identity could not be linked to ${userId}`);
  }

  async unlinkExternalIdentity(
    userId: string,
    reference: IdentityReference,
  ): Promise<UnlinkIdentityResult> {
    const key = this.userKey(userId);
    const indexKey = await this.identityIndexKey(
      identityValueFor(reference),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const index = await this.loadIdentityIndex(indexKey);
      if (
        !index ||
        index.value.linked === false ||
        index.value.userId !== userId
      ) {
        return { status: "missing" };
      }
      const object = await this.store.get(key);
      if (!object) {
        return { status: "missing" };
      }
      const current = normaliseExternalAuthUser(
        decodeJson<unknown>(object.bytes),
      );
      if (!current) {
        return { status: "missing" };
      }
      const identity = findIdentity(current, reference);
      if (!identity) {
        return { status: "missing" };
      }
      if (current.identities.length <= 1) {
        return { status: "last_identity" };
      }
      const updated: AuthUser = {
        ...current,
        authVersion: current.authVersion + 1,
        identities: current.identities.filter(
          (candidate) => candidate !== identity,
        ),
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.putJson(key, updated, {
          ifMatch: object.etag,
        });
      } catch (error) {
        if (isPreconditionFailure(error)) {
          continue;
        }
        throw error;
      }
      try {
        await this.putJson<IdentityIndex>(
          indexKey,
          {
            userId,
            linked: false,
            nonce: randomToken(16),
          },
          { ifMatch: index.object.etag },
        );
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        const latestUser = await this.getUser(userId);
        if (latestUser && findIdentity(latestUser, reference)) {
          return { status: "concurrent" };
        }
        const latestIndex = await this.loadIdentityIndex(indexKey);
        if (latestIndex?.value.linked !== false) {
          continue;
        }
      }
      await this.revokeAllSessions(userId);
      return { status: "unlinked", user: updated };
    }
    throw new Error(`External identity could not be unlinked from ${userId}`);
  }

  async updateAdministration(
    userId: string,
    changes: {
      status?: AuthUser["status"];
      roles?: string[];
      tenants?: string[];
    },
  ): Promise<AuthUser | null> {
    const key = this.userKey(userId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const object = await this.store.get(key);
      if (!object) {
        return null;
      }
      const current = normaliseExternalAuthUser(
        decodeJson<unknown>(object.bytes),
      );
      if (!current) {
        return null;
      }
      const updated: AuthUser = {
        ...current,
        authVersion: current.authVersion + 1,
        ...(changes.status ? { status: changes.status } : {}),
        ...(changes.roles
          ? { roles: sortedUnique(changes.roles) }
          : {}),
        ...(changes.tenants
          ? { tenants: sortedUnique(changes.tenants) }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.putJson(key, updated, {
          ifMatch: object.etag,
        });
      } catch (error) {
        if (isPreconditionFailure(error)) {
          continue;
        }
        throw error;
      }
      await this.revokeAllSessions(userId);
      return updated;
    }
    throw new Error(`External user ${userId} could not be administered`);
  }

  private async findByIdentity(
    identityValue: string,
  ): Promise<AuthUser | null> {
    const index = await this.getJson<IdentityIndex>(
      await this.identityIndexKey(identityValue),
    );
    return index && index.linked !== false
      ? this.getUser(index.userId)
      : null;
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
      const raw = decodeJson<unknown>(object.bytes);
      const current = normaliseExternalAuthUser(raw);
      if (!current) {
        throw new Error(`External user ${userId} is invalid`);
      }
      const stored = storedIdentity(identity);
      const identityIndex = current.identities.findIndex(
        (candidate) => identityMatches(candidate, identity),
      );
      if (identityIndex < 0) {
        throw new Error(`External identity is missing from user ${userId}`);
      }
      const existingIdentity = current.identities[identityIndex]!;
      if (
        currentSchema(raw) &&
        sameStrings(existingIdentity.roles, stored.roles) &&
        sameStrings(existingIdentity.tenants, stored.tenants)
      ) {
        return current;
      }
      const identities = [...current.identities];
      identities[identityIndex] = stored;
      const updated: AuthUser = {
        ...current,
        identities,
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

  private async loadIdentityIndex(key: string): Promise<{
    object: StoredObject;
    value: IdentityIndex;
  } | null> {
    const object = await this.store.get(key);
    return object
      ? {
          object,
          value: decodeJson<IdentityIndex>(object.bytes),
        }
      : null;
  }

  private async getExternalUser(
    key: string,
  ): Promise<AuthUser | null> {
    const value = await this.getJson<unknown>(key);
    return normaliseExternalAuthUser(value);
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

function normaliseExternalAuthUser(
  value: unknown,
): AuthUser | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    "password" in value
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    (candidate.status !== "active" &&
      candidate.status !== "disabled") ||
    typeof candidate.authVersion !== "number" ||
    !Array.isArray(candidate.identities) ||
    !Array.isArray(candidate.roles) ||
    !candidate.roles.every((role) => typeof role === "string") ||
    !Array.isArray(candidate.tenants) ||
    !candidate.tenants.every(
      (tenant) => typeof tenant === "string",
    ) ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }
  const usesCurrentSchema = candidate.identities.every(
    (identity) =>
      typeof identity === "object" &&
      identity !== null &&
      !Array.isArray(identity) &&
      Array.isArray((identity as { roles?: unknown }).roles) &&
      Array.isArray((identity as { tenants?: unknown }).tenants),
  );
  const identities = candidate.identities.map((identity) =>
    normaliseStoredIdentity(
      identity,
      usesCurrentSchema ? [] : candidate.roles as string[],
      usesCurrentSchema ? [] : candidate.tenants as string[],
    ),
  );
  if (identities.some((identity) => identity === null)) {
    return null;
  }
  return {
    id: candidate.id,
    status: candidate.status,
    authVersion: candidate.authVersion,
    identities: identities as Identity[],
    roles: usesCurrentSchema
      ? sortedUnique(candidate.roles as string[])
      : [],
    tenants: usesCurrentSchema
      ? sortedUnique(candidate.tenants as string[])
      : [],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function normaliseStoredIdentity(
  value: unknown,
  fallbackRoles: string[],
  fallbackTenants: string[],
): Identity | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.provider !== "entra" &&
      candidate.provider !== "oidc") ||
    typeof candidate.issuer !== "string" ||
    typeof candidate.subject !== "string" ||
    (candidate.provider === "entra" &&
      typeof candidate.tenantId !== "string")
  ) {
    return null;
  }
  const roles = Array.isArray(candidate.roles)
    ? candidate.roles.filter(
        (role): role is string => typeof role === "string",
      )
    : fallbackRoles;
  const tenants = Array.isArray(candidate.tenants)
    ? candidate.tenants.filter(
        (tenant): tenant is string => typeof tenant === "string",
      )
    : fallbackTenants;
  return candidate.provider === "entra"
    ? {
        provider: "entra",
        issuer: candidate.issuer,
        subject: candidate.subject,
        tenantId: candidate.tenantId as string,
        roles: sortedUnique(roles),
        tenants: sortedUnique(tenants),
      }
    : {
        provider: "oidc",
        issuer: candidate.issuer,
        subject: candidate.subject,
        roles: sortedUnique(roles),
        tenants: sortedUnique(tenants),
      };
}

function isExternalProvider(
  value: unknown,
): value is Identity["provider"] {
  return value === "entra" || value === "oidc";
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
  return {
    id: crypto.randomUUID(),
    status: "active",
    authVersion: 1,
    identities: [storedIdentity(identity)],
    roles: [],
    tenants: [],
    createdAt: now,
    updatedAt: now,
  };
}

function storedIdentity(identity: ExternalIdentity): Identity {
  const roles = sortedUnique(identity.roles);
  const tenants = identity.tenantId ? [identity.tenantId] : [];
  return identity.provider === "entra"
    ? {
        provider: "entra",
        issuer: identity.issuer,
        subject: identity.subject,
        tenantId: identity.tenantId ?? "",
        roles,
        tenants,
      }
    : {
        provider: "oidc",
        issuer: identity.issuer,
        subject: identity.subject,
        roles,
        tenants,
      };
}

export function findIdentity(
  user: AuthUser,
  reference: IdentityReference,
): Identity | null {
  return (
    user.identities.find((identity) =>
      identityMatches(identity, reference),
    ) ?? null
  );
}

function identityMatches(
  identity: Identity,
  reference: IdentityReference,
): boolean {
  return (
    identity.provider === reference.provider &&
    identity.issuer === reference.issuer &&
    identity.subject === reference.subject
  );
}

function identityValueFor(
  identity: IdentityReference,
): string {
  return `${identity.provider}|${identity.issuer}|${identity.subject}`;
}

function currentSchema(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const identities = (value as { identities?: unknown }).identities;
  return (
    Array.isArray(identities) &&
    identities.every(
      (identity) =>
        typeof identity === "object" &&
        identity !== null &&
        !Array.isArray(identity) &&
        Array.isArray((identity as { roles?: unknown }).roles) &&
        Array.isArray((identity as { tenants?: unknown }).tenants),
    )
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
