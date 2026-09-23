import {
  AuthError,
  AuthService,
  type AuthenticatedSession,
} from "./auth/service.js";
import { createEntraAdapter } from "./auth/oidc.js";
import { PasswordHasher } from "./auth/password.js";
import { DefaultScopeAuthorizer } from "./auth/policy.js";
import type {
  AuthRateLimiter,
  RateLimitResult,
} from "./auth/rate-limit.js";
import { ObjectStoreAuthRateLimiter } from "./auth/rate-limit.js";
import { AuthRepository } from "./auth/repository.js";
import type { ScopeGrant } from "./auth/types.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "./cloudflare/r2-object-store.js";
import type { JsonDocument, ObjectStore } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import {
  base64ToBytes,
  bytesToBase64,
  importAesGcmKey,
} from "./envelope.js";
import { PrefixObjectStore } from "./prefix-store.js";
import {
  generateStoreDataset,
  workloadProfiles,
} from "./workload.js";
import { scopeStoragePrefix } from "./trie-protocol.js";

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type Env = {
  DB: R2BucketBinding;
  AUTH_DB: R2BucketBinding;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  THIMBLE_MASTER_KEY: string;
  THIMBLE_PASSWORD_PEPPER: string;
  THIMBLE_ALLOWED_ORIGIN: string;
  THIMBLE_PREFIX?: string;
  THIMBLE_KEY_VERSION?: string;
  THIMBLE_HEAD_TTL_MS?: string;
  THIMBLE_LOCAL_REGISTRATION?: string;
  ENTRA_TENANT_ID?: string;
  ENTRA_AUDIENCE?: string;
};

type ScopeRuntime = {
  material: WorkerScopeMaterial;
  engine: ContentAddressedTrieEngine;
};

type WorkerScopeMaterial = {
  scopeId: string;
  encrypted: boolean;
  keyId: string | null;
  rawKey: Uint8Array | null;
  key: CryptoKey | null;
  addressNode(bytes: Uint8Array): Promise<string>;
};

type Runtime = {
  auth: AuthService;
  dataRootStore: ObjectStore;
  headTtlMs: number;
  registrationEnabled: boolean;
  oidcProviders: string[];
  allowedOrigin: string;
  scope(scopeId: string): Promise<ScopeRuntime>;
};

let runtimePromise: Promise<Runtime> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(await runtimeFor(env), request, env);
    } catch (error) {
      if (!(error instanceof AuthError && error.status < 500)) {
        console.error(error);
      }
      const status = error instanceof AuthError ? error.status : 500;
      const headers = new Headers();
      if (error instanceof AuthError && error.retryAfterSeconds) {
        headers.set("retry-after", String(error.retryAfterSeconds));
      }
      return json(
        {
          error:
            error instanceof AuthError
              ? error.code
              : "internal_error",
          message:
            error instanceof AuthError
              ? error.message
              : "Request failed",
        },
        status,
        headers,
      );
    }
  },
};

async function route(
  runtime: Runtime,
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (
    request.method === "GET" &&
    url.pathname === "/api/auth/config"
  ) {
    return json({
      local: {
        enabled: true,
        registrationEnabled: runtime.registrationEnabled,
        minimumPasswordBytes: 12,
      },
      oidcProviders: runtime.oidcProviders,
    });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/register"
  ) {
    requireMutationRequest(runtime, request);
    const credentials = localCredentials(await request.json());
    await runtime.auth.register(
      credentials.login,
      credentials.password,
      clientRateKey(request),
    );
    return json(
      {
        accepted: true,
        message:
          "If the account can be created, it is now available for login",
      },
      202,
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/login"
  ) {
    requireMutationRequest(runtime, request);
    const credentials = localCredentials(await request.json());
    await runtime.auth.logout(
      cookieValue(
        request.headers.get("cookie"),
        runtime.auth.cookieName(),
      ),
    );
    const authenticated = await runtime.auth.login(
      credentials.login,
      credentials.password,
      clientRateKey(request),
    );
    return json(
      { user: publicUser(authenticated) },
      200,
      new Headers({
        "set-cookie": runtime.auth.sessionCookie(
          authenticated.cookieValue,
        ),
      }),
    );
  }

  const oidcRoute = /^\/api\/auth\/oidc\/([^/]+)\/session$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && oidcRoute?.[1]) {
    requireMutationRequest(runtime, request);
    await runtime.auth.logout(
      cookieValue(
        request.headers.get("cookie"),
        runtime.auth.cookieName(),
      ),
    );
    const authenticated = await runtime.auth.loginExternal(
      decodeURIComponent(oidcRoute[1]),
      bearerToken(request),
      clientRateKey(request),
    );
    return json(
      { user: publicUser(authenticated) },
      200,
      new Headers({
        "set-cookie": runtime.auth.sessionCookie(
          authenticated.cookieValue,
        ),
      }),
    );
  }

  const authenticated = await runtime.auth.authenticate(
    cookieValue(
      request.headers.get("cookie"),
      runtime.auth.cookieName(),
    ),
  );

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/logout"
  ) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    await runtime.auth.logout(authenticated.cookieValue);
    return json(
      { loggedOut: true },
      200,
      new Headers({
        "set-cookie": runtime.auth.clearSessionCookie(),
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    requireAuthenticated(authenticated);
    const grant = defaultGrant(authenticated.session.grants);
    const scope = await runtime.scope(grant.scopeId);
    return json({
      name: "ThimbleDB",
      provider: "r2",
      readBaseUrl: "/api/objects",
      headTtlMs: runtime.headTtlMs,
      cachePolicy: "content",
      csrfToken: authenticated.session.csrfToken,
      user: publicUser(authenticated),
      scope: {
        id: grant.scopeId,
        encrypted: scope.material.encrypted,
        keyId: scope.material.keyId,
        keyEndpoint: scope.material.encrypted
          ? `/api/keys/${encodeURIComponent(grant.scopeId)}`
          : null,
      },
    });
  }

  const keyRoute = /^\/api\/keys\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && keyRoute?.[1]) {
    requireAuthenticated(authenticated);
    const scopeId = decodeURIComponent(keyRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "read");
    const scope = await runtime.scope(scopeId);
    if (
      !scope.material.encrypted ||
      !scope.material.keyId ||
      !scope.material.rawKey
    ) {
      throw new AuthError(
        404,
        "scope_key_not_found",
        "Encrypted scope not found",
      );
    }
    return json({
      scopeId,
      keyId: scope.material.keyId,
      key: bytesToBase64(scope.material.rawKey),
      algorithm: "A256GCM",
      expiresAt: authenticated.session.expiresAt,
    });
  }

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/api/objects/")
  ) {
    requireAuthenticated(authenticated);
    const key = decodeObjectPath(
      url.pathname.slice("/api/objects/".length),
    );
    const scopeId = scopeFromObjectKey(key);
    requireGrant(authenticated.session.grants, scopeId, "read");
    return objectResponse(runtime.dataRootStore, key, request);
  }

  if (request.method === "POST" && url.pathname === "/api/seed") {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const grant = selectedWriteGrant(
      authenticated.session.grants,
      request,
    );
    const scope = await runtime.scope(grant.scopeId);
    const profile =
      url.searchParams.get("profile") === "small"
        ? workloadProfiles.small
        : workloadProfiles.tiny;
    const dataset = generateStoreDataset(profile);
    await scope.engine.putMany("products", dataset.products);
    await scope.engine.putMany("customers", dataset.customers);
    await scope.engine.putMany("orders", dataset.orders);
    return json({
      profile: profile.name,
      scopeId: grant.scopeId,
      products: dataset.products.length,
      customers: dataset.customers.length,
      orders: dataset.orders.length,
    });
  }

  const writeRoute =
    /^\/api\/collections\/([^/]+)\/documents\/([^/]+)$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && writeRoute?.[1] && writeRoute[2]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const grant = selectedWriteGrant(
      authenticated.session.grants,
      request,
    );
    const scope = await runtime.scope(grant.scopeId);
    const collection = decodeURIComponent(writeRoute[1]);
    const id = decodeURIComponent(writeRoute[2]);
    const document = asDocument(await request.json(), id);
    await scope.engine.put(collection, id, document);
    return json(await scope.engine.readBundle(collection, id));
  }

  if (env.ASSETS) {
    return secureAssetResponse(await env.ASSETS.fetch(request));
  }
  return json({ error: "not_found" }, 404);
}

async function createRuntime(env: Env): Promise<Runtime> {
  const masterKey = base64ToBytes(env.THIMBLE_MASTER_KEY);
  const pepper = base64ToBytes(env.THIMBLE_PASSWORD_PEPPER);
  if (masterKey.byteLength !== 32 || pepper.byteLength < 32) {
    throw new Error(
      "THIMBLE_MASTER_KEY and THIMBLE_PASSWORD_PEPPER must contain at least 32 bytes",
    );
  }
  if (!env.THIMBLE_ALLOWED_ORIGIN) {
    throw new Error("THIMBLE_ALLOWED_ORIGIN is required");
  }
  const prefix = env.THIMBLE_PREFIX ?? "demo";
  const dataRootStore: ObjectStore = new PrefixObjectStore(
    new R2ObjectStore(env.DB),
    prefix,
  );
  const authMaterial = await scopeMaterial(
    masterKey,
    "system-auth",
    1,
  );
  const authStore = new EnvelopeObjectStore(
    new PrefixObjectStore(
      new R2ObjectStore(env.AUTH_DB),
      "auth-v1",
    ),
    {
      key: authMaterial.key!,
      keyId: authMaterial.keyId!,
      compression: "gzip",
      objectKeyPrefix: "auth-v1",
    },
  );
  const authIndex = (value: string) =>
    authMaterial.addressNode(new TextEncoder().encode(value));
  const repository = new AuthRepository(
    authStore,
    authIndex,
    hashText,
  );
  await repository.ensureDummyUser();
  const adapters = new Map();
  if (env.ENTRA_TENANT_ID && env.ENTRA_AUDIENCE) {
    adapters.set(
      "entra",
      createEntraAdapter({
        tenantId: env.ENTRA_TENANT_ID,
        audience: env.ENTRA_AUDIENCE,
      }),
    );
  }
  const rateLimiter = workerRateLimiter(
    env,
    authStore,
    authIndex,
  );
  const auth = new AuthService({
    repository,
    passwords: new PasswordHasher(pepper),
    authorizer: new DefaultScopeAuthorizer(),
    rateLimiter,
    identityAdapters: adapters,
    registrationEnabled:
      env.THIMBLE_LOCAL_REGISTRATION === "true",
    sessionTtlSeconds: 3_600,
    secureCookies: true,
  });
  const cache = new Map<string, Promise<ScopeRuntime>>();
  const scope = (scopeId: string): Promise<ScopeRuntime> => {
    let runtime = cache.get(scopeId);
    if (!runtime) {
      runtime = createScopeRuntime(
        dataRootStore,
        masterKey,
        scopeId,
        parseInteger(env.THIMBLE_KEY_VERSION, 1),
      );
      cache.set(scopeId, runtime);
    }
    return runtime;
  };

  return {
    auth,
    dataRootStore,
    headTtlMs: parseInteger(env.THIMBLE_HEAD_TTL_MS, 1_000),
    registrationEnabled:
      env.THIMBLE_LOCAL_REGISTRATION === "true",
    oidcProviders: [...adapters.keys()],
    allowedOrigin: env.THIMBLE_ALLOWED_ORIGIN,
    scope,
  };
}

async function createScopeRuntime(
  dataRootStore: ObjectStore,
  masterKey: Uint8Array,
  scopeId: string,
  version: number,
): Promise<ScopeRuntime> {
  const material = await scopeMaterial(
    masterKey,
    scopeId,
    version,
  );
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(
      dataRootStore,
      scopeStoragePrefix(scopeId),
    ),
    {
      key: material.key!,
      keyId: material.keyId!,
      compression: "gzip",
      objectKeyPrefix: scopeStoragePrefix(scopeId),
    },
  );
  return {
    material,
    engine: new ContentAddressedTrieEngine(
      store,
      40,
      material.addressNode,
    ),
  };
}

async function scopeMaterial(
  masterKey: Uint8Array,
  scopeId: string,
  versionNumber: number,
): Promise<WorkerScopeMaterial> {
  const version = `v${versionNumber}`;
  const rawKey = await deriveBytes(
    masterKey,
    `encryption:${scopeId}:${version}`,
  );
  const addressKey = await importHmacKey(
    await deriveBytes(masterKey, `address:${scopeId}:${version}`),
  );
  return {
    scopeId,
    encrypted: true,
    keyId: `${scopeId}:${version}`,
    rawKey,
    key: await importAesGcmKey(
      rawKey,
      ["encrypt", "decrypt"],
    ),
    addressNode: (bytes) => hmacHex(addressKey, bytes),
  };
}

function workerRateLimiter(
  env: Env,
  authStore: ObjectStore,
  authIndex: (value: string) => Promise<string>,
): AuthRateLimiter {
  if (env.AUTH_RATE_LIMITER) {
    return {
      async consume(key: string): Promise<RateLimitResult> {
        const result = await env.AUTH_RATE_LIMITER!.limit({ key });
        return {
          allowed: result.success,
          retryAfterSeconds: result.success ? 0 : 60,
        };
      },
    };
  }
  return new ObjectStoreAuthRateLimiter(
    authStore,
    authIndex,
  );
}

async function runtimeFor(env: Env): Promise<Runtime> {
  runtimePromise ??= createRuntime(env);
  return runtimePromise;
}

function requireMutationRequest(
  runtime: Runtime,
  request: Request,
  csrfToken?: string,
): void {
  if (request.headers.get("origin") !== runtime.allowedOrigin) {
    throw new AuthError(403, "origin_rejected", "Request was rejected");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AuthError(
      415,
      "content_type_required",
      "application/json is required",
    );
  }
  if (csrfToken) {
    runtime.auth.requireCsrf(
      csrfToken,
      request.headers.get("x-thimble-csrf"),
    );
  }
}

function requireAuthenticated(
  session: AuthenticatedSession | null,
): asserts session is AuthenticatedSession {
  if (!session) {
    throw new AuthError(
      401,
      "authentication_required",
      "Authentication is required",
    );
  }
}

function requireGrant(
  grants: ScopeGrant[],
  scopeId: string,
  permission: "read" | "write" | "admin",
): ScopeGrant {
  const grant = grants.find(
    (candidate) =>
      candidate.scopeId === scopeId &&
      candidate.permissions.includes(permission),
  );
  if (!grant) {
    throw new AuthError(403, "scope_denied", "Access was denied");
  }
  return grant;
}

function defaultGrant(grants: ScopeGrant[]): ScopeGrant {
  const grant = grants.find((candidate) =>
    candidate.permissions.includes("read"),
  );
  if (!grant) {
    throw new AuthError(403, "scope_denied", "Access was denied");
  }
  return grant;
}

function selectedWriteGrant(
  grants: ScopeGrant[],
  request: Request,
): ScopeGrant {
  const requested = request.headers.get("x-thimble-scope");
  if (requested) {
    return requireGrant(grants, requested, "write");
  }
  const grant = grants.find((candidate) =>
    candidate.permissions.includes("write"),
  );
  if (!grant) {
    throw new AuthError(403, "scope_denied", "Access was denied");
  }
  return grant;
}

async function objectResponse(
  store: ObjectStore,
  key: string,
  request: Request,
): Promise<Response> {
  const object = await store.get(key);
  if (!object) {
    return new Response(null, {
      status: 404,
      headers: securityHeaders(),
    });
  }
  const etag = quoteEtag(object.etag);
  if (
    normaliseEtag(request.headers.get("if-none-match")) ===
    normaliseEtag(etag)
  ) {
    return new Response(null, {
      status: 304,
      headers: securityHeaders({ etag }),
    });
  }
  return new Response(bufferView(object.bytes), {
    status: 200,
    headers: securityHeaders({
      "content-type": "application/vnd.thimbledb.object",
      "cache-control": "private, no-cache",
      etag,
    }),
  });
}

function json(
  value: unknown,
  status = 200,
  additionalHeaders = new Headers(),
): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: securityHeaders({
      ...Object.fromEntries(additionalHeaders),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

async function secureAssetResponse(
  response: Response,
): Promise<Response> {
  const headers = securityHeaders(Object.fromEntries(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function securityHeaders(
  additional: Record<string, string> = {},
): Headers {
  return new Headers({
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=()",
    ...additional,
  });
}

function localCredentials(
  value: unknown,
): { login: string; password: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { login?: unknown }).login !== "string" ||
    typeof (value as { password?: unknown }).password !== "string"
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return {
    login: (value as { login: string }).login,
    password: (value as { password: string }).password,
  };
}

function asDocument(value: unknown, id: string): JsonDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { id?: unknown }).id !== id
  ) {
    throw new AuthError(
      400,
      "invalid_document",
      "Document id must match the route id",
    );
  }
  return value as JsonDocument;
}

function publicUser(session: AuthenticatedSession) {
  return {
    id: session.user.id,
    provider: session.principal.provider,
    roles: [...session.principal.roles],
    tenants: [...session.principal.tenantIds],
  };
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new AuthError(
      401,
      "invalid_credentials",
      "Invalid credentials",
    );
  }
  return authorization.slice("Bearer ".length);
}

function clientRateKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function scopeFromObjectKey(key: string): string {
  const match = /^scopes\/([^/]+)\//.exec(key);
  if (!match?.[1]) {
    throw new AuthError(404, "object_not_found", "Object not found");
  }
  return decodeURIComponent(match[1]);
}

async function deriveBytes(
  masterKey: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    bufferView(masterKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("thimbledb-scope-v1"),
        info: new TextEncoder().encode(info),
      },
      material,
      256,
    ),
  );
}

function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bufferView(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacHex(
  key: CryptoKey,
  bytes: Uint8Array,
): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, bufferView(bytes)),
    ),
  );
}

async function hashText(value: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      ),
    ),
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

function cookieValue(
  cookie: string | null,
  name: string,
): string | null {
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }
  return null;
}

function decodeObjectPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function quoteEtag(etag: string): string {
  const raw = normaliseEtag(etag);
  return raw ? `"${raw}"` : '""';
}

function normaliseEtag(etag: string | null): string | null {
  return etag
    ? etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "")
    : null;
}

function bufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}
