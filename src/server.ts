import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  AuthError,
  AuthService,
  type AuthenticatedSession,
} from "./auth/service.js";
import { createEntraAdapter } from "./auth/oidc.js";
import { PasswordHasher } from "./auth/password.js";
import { DefaultScopeAuthorizer } from "./auth/policy.js";
import { ObjectStoreAuthRateLimiter } from "./auth/rate-limit.js";
import { AuthRepository } from "./auth/repository.js";
import type {
  ScopeGrant,
} from "./auth/types.js";
import type { JsonDocument, ObjectStore } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import {
  loadOrCreateSecret,
  loadScopeMaterial,
  scopeKeyResponse,
  type ScopeMaterial,
} from "./server-keys.js";
import {
  AzureBlobObjectStore,
  LocalObjectStore,
  PrefixObjectStore,
  S3ObjectStore,
} from "./stores.js";
import {
  generateStoreDataset,
  workloadProfiles,
} from "./workload.js";
import { scopeStoragePrefix } from "./trie-protocol.js";

type Provider = "local" | "azure" | "s3" | "r2";

type ScopeRuntime = {
  material: ScopeMaterial;
  engine: ContentAddressedTrieEngine;
};

type ServerContext = {
  provider: Provider;
  dataRootStore: ObjectStore;
  auth: AuthService;
  allowedOrigin: string;
  headTtlMs: number;
  registrationEnabled: boolean;
  oidcProviders: string[];
  scope(scopeId: string): Promise<ScopeRuntime>;
};

const host = process.env.THIMBLE_HOST ?? "127.0.0.1";
const port = parseInteger(process.env.THIMBLE_PORT, 8787);
const context = await createContext();
const server = createServer((request, response) => {
  void handleRequest(context, request, response).catch((error) => {
    if (!(error instanceof AuthError && error.status < 500)) {
      console.error(error);
    }
    if (!response.headersSent) {
      const status = error instanceof AuthError ? error.status : 500;
      const headers: Record<string, string> = {};
      if (error instanceof AuthError && error.retryAfterSeconds) {
        headers["retry-after"] = String(error.retryAfterSeconds);
      }
      sendJson(
        response,
        status,
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
        headers,
      );
    } else {
      response.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(
    `ThimbleDB authority listening on http://${host}:${port} (${context.provider})`,
  );
});

async function createContext(): Promise<ServerContext> {
  const provider = providerName();
  const prefix = process.env.THIMBLE_PREFIX ?? "demo";
  const stores = createProviderStores(provider);
  const dataRootStore = new PrefixObjectStore(stores.data, prefix);
  const authMaterial = await loadScopeMaterial({
    scopeId: "system-auth",
    encrypted: true,
    keyVersion: 1,
    local: provider === "local",
  });
  const authStore = new EnvelopeObjectStore(
    new PrefixObjectStore(stores.auth, "auth-v1"),
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
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  await repository.ensureDummyUser();
  const pepper = await loadOrCreateSecret(
    "THIMBLE_PASSWORD_PEPPER",
    "password-pepper.key",
    provider === "local",
    32,
  );
  const identityAdapters = new Map();
  if (
    process.env.ENTRA_TENANT_ID &&
    process.env.ENTRA_AUDIENCE
  ) {
    identityAdapters.set(
      "entra",
      createEntraAdapter({
        tenantId: process.env.ENTRA_TENANT_ID,
        audience: process.env.ENTRA_AUDIENCE,
      }),
    );
  }
  const secureCookies =
    process.env.THIMBLE_SECURE_COOKIES === "true" ||
    provider !== "local";
  const auth = new AuthService({
    repository,
    passwords: new PasswordHasher(pepper),
    authorizer: new DefaultScopeAuthorizer(),
    rateLimiter: new ObjectStoreAuthRateLimiter(
      authStore,
      authIndex,
      parseInteger(process.env.THIMBLE_AUTH_RATE_LIMIT, 5),
      parseInteger(process.env.THIMBLE_AUTH_RATE_WINDOW_MS, 60_000),
    ),
    identityAdapters,
    registrationEnabled:
      process.env.THIMBLE_LOCAL_REGISTRATION === "true" ||
      provider === "local",
    sessionTtlSeconds: parseInteger(
      process.env.THIMBLE_SESSION_TTL_SECONDS,
      3_600,
    ),
    secureCookies,
  });

  const scopeCache = new Map<string, Promise<ScopeRuntime>>();
  const scope = (scopeId: string): Promise<ScopeRuntime> => {
    let runtime = scopeCache.get(scopeId);
    if (!runtime) {
      runtime = createScopeRuntime(
        dataRootStore,
        scopeId,
        provider === "local",
      );
      scopeCache.set(scopeId, runtime);
    }
    return runtime;
  };

  return {
    provider,
    dataRootStore,
    auth,
    allowedOrigin:
      process.env.THIMBLE_ALLOWED_ORIGIN ??
      (provider === "local"
        ? "http://127.0.0.1:5173"
        : requiredEnvironment("THIMBLE_ALLOWED_ORIGIN")),
    headTtlMs: parseInteger(
      process.env.THIMBLE_HEAD_TTL_MS,
      1_000,
    ),
    registrationEnabled:
      process.env.THIMBLE_LOCAL_REGISTRATION === "true" ||
      provider === "local",
    oidcProviders: [...identityAdapters.keys()],
    scope,
  };
}

async function createScopeRuntime(
  dataRootStore: ObjectStore,
  scopeId: string,
  local: boolean,
): Promise<ScopeRuntime> {
  const material = await loadScopeMaterial({
    scopeId,
    encrypted: scopeId !== "public",
    keyVersion: parseInteger(process.env.THIMBLE_KEY_VERSION, 1),
    local,
  });
  const rawStore = new PrefixObjectStore(
    dataRootStore,
    scopeStoragePrefix(scopeId),
  );
  const store = new EnvelopeObjectStore(
    rawStore,
    material.encrypted
      ? {
          key: material.key!,
          keyId: material.keyId!,
          compression: "gzip",
          objectKeyPrefix: scopeStoragePrefix(scopeId),
        }
      : {
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

async function handleRequest(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );

  if (
    request.method === "GET" &&
    url.pathname === "/api/auth/config"
  ) {
    sendJson(response, 200, {
      local: {
        enabled: true,
        registrationEnabled: context.registrationEnabled,
        minimumPasswordBytes: 12,
      },
      oidcProviders: context.oidcProviders,
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/register"
  ) {
    requireMutationRequest(context, request);
    const body = await readJsonBody(request);
    const credentials = localCredentials(body);
    await context.auth.register(
      credentials.login,
      credentials.password,
      clientRateKey(request),
    );
    sendJson(response, 202, {
      accepted: true,
      message:
        "If the account can be created, it is now available for login",
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/login"
  ) {
    requireMutationRequest(context, request);
    const body = await readJsonBody(request);
    const credentials = localCredentials(body);
    await context.auth.logout(
      sessionCookie(request, context.auth.cookieName()),
    );
    const authenticated = await context.auth.login(
      credentials.login,
      credentials.password,
      clientRateKey(request),
    );
    response.setHeader(
      "set-cookie",
      context.auth.sessionCookie(authenticated.cookieValue),
    );
    sendJson(response, 200, {
      user: publicUser(authenticated),
    });
    return;
  }

  const oidcRoute = /^\/api\/auth\/oidc\/([^/]+)\/session$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && oidcRoute?.[1]) {
    requireMutationRequest(context, request);
    const bearer = bearerToken(request);
    await context.auth.logout(
      sessionCookie(request, context.auth.cookieName()),
    );
    const authenticated = await context.auth.loginExternal(
      decodeURIComponent(oidcRoute[1]),
      bearer,
      clientRateKey(request),
    );
    response.setHeader(
      "set-cookie",
      context.auth.sessionCookie(authenticated.cookieValue),
    );
    sendJson(response, 200, {
      user: publicUser(authenticated),
    });
    return;
  }

  const authenticated = await context.auth.authenticate(
    sessionCookie(request, context.auth.cookieName()),
  );

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/logout"
  ) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    await context.auth.logout(authenticated.cookieValue);
    response.setHeader(
      "set-cookie",
      context.auth.clearSessionCookie(),
    );
    sendJson(response, 200, { loggedOut: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    requireAuthenticated(authenticated);
    const grant = defaultGrant(authenticated.session.grants);
    const runtime = await context.scope(grant.scopeId);
    sendJson(response, 200, {
      name: "ThimbleDB",
      provider: context.provider,
      readBaseUrl: "/api/objects",
      headTtlMs: context.headTtlMs,
      cachePolicy: "content",
      csrfToken: authenticated.session.csrfToken,
      user: publicUser(authenticated),
      scope: {
        id: grant.scopeId,
        encrypted: runtime.material.encrypted,
        keyId: runtime.material.keyId,
        keyEndpoint: runtime.material.encrypted
          ? `/api/keys/${encodeURIComponent(grant.scopeId)}`
          : null,
      },
    });
    return;
  }

  const keyRoute = /^\/api\/keys\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && keyRoute?.[1]) {
    requireAuthenticated(authenticated);
    const scopeId = decodeURIComponent(keyRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "read");
    const runtime = await context.scope(scopeId);
    if (!runtime.material.encrypted) {
      throw new AuthError(
        404,
        "scope_key_not_found",
        "Encrypted scope not found",
      );
    }
    sendJson(response, 200, {
      ...scopeKeyResponse(runtime.material),
      expiresAt: authenticated.session.expiresAt,
    });
    return;
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
    await sendObject(context.dataRootStore, key, request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/seed") {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const grant = selectedWriteGrant(
      authenticated.session.grants,
      request,
    );
    const runtime = await context.scope(grant.scopeId);
    const profile =
      url.searchParams.get("profile") === "small"
        ? workloadProfiles.small
        : workloadProfiles.tiny;
    const dataset = generateStoreDataset(profile);
    await runtime.engine.putMany("products", dataset.products);
    await runtime.engine.putMany("customers", dataset.customers);
    await runtime.engine.putMany("orders", dataset.orders);
    sendJson(response, 200, {
      profile: profile.name,
      scopeId: grant.scopeId,
      products: dataset.products.length,
      customers: dataset.customers.length,
      orders: dataset.orders.length,
    });
    return;
  }

  const writeRoute =
    /^\/api\/collections\/([^/]+)\/documents\/([^/]+)$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && writeRoute?.[1] && writeRoute[2]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const grant = selectedWriteGrant(
      authenticated.session.grants,
      request,
    );
    const runtime = await context.scope(grant.scopeId);
    const collection = decodeURIComponent(writeRoute[1]);
    const id = decodeURIComponent(writeRoute[2]);
    const document = asDocument(await readJsonBody(request), id);
    await runtime.engine.put(collection, id, document);
    sendJson(
      response,
      200,
      await runtime.engine.readBundle(collection, id),
    );
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (
      await serveBrowserAsset(
        url.pathname,
        request.method,
        response,
      )
    ) {
      return;
    }
  }

  sendJson(response, 404, { error: "not_found" });
}

function createProviderStores(provider: Provider): {
  data: ObjectStore;
  auth: ObjectStore;
} {
  if (provider === "local") {
    return {
      data: new LocalObjectStore(path.resolve(".thimble-data")),
      auth: new LocalObjectStore(path.resolve(".thimble-auth")),
    };
  }
  if (provider === "azure") {
    const connectionString = requiredEnvironment(
      "AZURE_STORAGE_CONNECTION_STRING",
    );
    const dataContainer =
      process.env.AZURE_STORAGE_CONTAINER ?? "thimbledb";
    const authContainer =
      process.env.AZURE_AUTH_STORAGE_CONTAINER ??
      `${dataContainer}-auth`;
    return {
      data: new AzureBlobObjectStore(
        connectionString,
        dataContainer,
      ),
      auth: new AzureBlobObjectStore(
        connectionString,
        authContainer,
      ),
    };
  }
  if (provider === "s3") {
    const clientConfig: {
      region: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    } = {
      region: process.env.AWS_REGION ?? "us-east-1",
    };
    if (process.env.S3_ENDPOINT) {
      clientConfig.endpoint = process.env.S3_ENDPOINT;
    }
    if (process.env.S3_FORCE_PATH_STYLE) {
      clientConfig.forcePathStyle =
        process.env.S3_FORCE_PATH_STYLE === "true";
    }
    return {
      data: new S3ObjectStore({
        bucket: requiredEnvironment("S3_BUCKET"),
        clientConfig,
      }),
      auth: new S3ObjectStore({
        bucket: requiredEnvironment("S3_AUTH_BUCKET"),
        clientConfig,
      }),
    };
  }

  const accountId = requiredEnvironment("R2_ACCOUNT_ID");
  const clientConfig = {
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
    },
  };
  return {
    data: new S3ObjectStore({
      bucket: requiredEnvironment("R2_BUCKET"),
      clientConfig,
    }),
    auth: new S3ObjectStore({
      bucket: requiredEnvironment("R2_AUTH_BUCKET"),
      clientConfig,
    }),
  };
}

async function sendObject(
  store: ObjectStore,
  key: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const object = await store.get(key);
  if (!object) {
    response.writeHead(404, securityHeaders()).end();
    return;
  }
  const etag = httpEtag(object.etag);
  if (sameEtag(request.headers["if-none-match"], etag)) {
    response
      .writeHead(304, { ...securityHeaders(), etag })
      .end();
    return;
  }
  response.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/vnd.thimbledb.object",
    "content-length": object.bytes.byteLength,
    "cache-control": "private, no-cache",
    etag,
  });
  response.end(Buffer.from(object.bytes));
}

function requireMutationRequest(
  context: ServerContext,
  request: IncomingMessage,
  csrfToken?: string,
): void {
  if (request.headers.origin !== context.allowedOrigin) {
    throw new AuthError(403, "origin_rejected", "Request was rejected");
  }
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AuthError(
      415,
      "content_type_required",
      "application/json is required",
    );
  }
  if (csrfToken) {
    context.auth.requireCsrf(
      csrfToken,
      headerValue(request.headers["x-thimble-csrf"]),
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
  request: IncomingMessage,
): ScopeGrant {
  const requested = headerValue(request.headers["x-thimble-scope"]);
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

function scopeFromObjectKey(key: string): string {
  const match = /^scopes\/([^/]+)\//.exec(key);
  if (!match?.[1]) {
    throw new AuthError(404, "object_not_found", "Object not found");
  }
  return decodeURIComponent(match[1]);
}

function localCredentials(
  value: unknown,
): { login: string; password: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.login !== "string" ||
    typeof candidate.password !== "string"
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return {
    login: candidate.login,
    password: candidate.password,
  };
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) {
      throw new AuthError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks).toString("utf8") || "{}",
    ) as unknown;
  } catch {
    throw new AuthError(400, "invalid_json", "Invalid JSON");
  }
}

function asDocument(value: unknown, id: string): JsonDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).id !== id
  ) {
    throw new AuthError(
      400,
      "invalid_document",
      "Document id must match the route id",
    );
  }
  return value as JsonDocument;
}

function publicUser(session: AuthenticatedSession): {
  id: string;
  provider: string;
  roles: string[];
  tenants: string[];
} {
  return {
    id: session.user.id,
    provider: session.principal.provider,
    roles: [...session.principal.roles],
    tenants: [...session.principal.tenantIds],
  };
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new AuthError(
      401,
      "invalid_credentials",
      "Invalid credentials",
    );
  }
  return authorization.slice("Bearer ".length);
}

function sessionCookie(
  request: IncomingMessage,
  cookieName: string,
): string | null {
  const cookie = request.headers.cookie;
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) {
      return value.join("=") || null;
    }
  }
  return null;
}

function clientRateKey(request: IncomingMessage): string {
  const forwarded = headerValue(request.headers["x-forwarded-for"]);
  return (
    forwarded?.split(",")[0]?.trim() ||
    request.socket.remoteAddress ||
    "unknown"
  );
}

function providerName(): Provider {
  const provider =
    process.env.THIMBLE_PROVIDER ??
    (process.env.AZURE_STORAGE_CONNECTION_STRING
      ? "azure"
      : "local");
  if (
    provider === "local" ||
    provider === "azure" ||
    provider === "s3" ||
    provider === "r2"
  ) {
    return provider;
  }
  throw new Error(`Unsupported THIMBLE_PROVIDER: ${provider}`);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  additionalHeaders: Record<string, string> = {},
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    ...securityHeaders(),
    ...additionalHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

async function serveBrowserAsset(
  pathname: string,
  method: string,
  response: ServerResponse,
): Promise<boolean> {
  const root = path.resolve("dist", "browser");
  const relativePath =
    pathname === "/"
      ? "index.html"
      : pathname.replace(/^\/+/, "");
  let filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    return false;
  }
  try {
    if ((await stat(filePath)).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch {
    filePath = path.join(root, "index.html");
  }
  try {
    const bytes = await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders(),
      "content-type": mimeType(filePath),
      "content-length": bytes.byteLength,
      "cache-control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    response.end(method === "HEAD" ? undefined : bytes);
    return true;
  } catch {
    return false;
  }
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function decodeObjectPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function httpEtag(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

function sameEtag(
  requestEtag: string | string[] | undefined,
  objectEtag: string,
): boolean {
  if (Array.isArray(requestEtag)) {
    return requestEtag.some((etag) => sameEtag(etag, objectEtag));
  }
  if (!requestEtag) {
    return false;
  }
  const normalize = (etag: string) =>
    etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return normalize(requestEtag) === normalize(objectEtag);
}

function headerValue(
  value: string | string[] | undefined,
): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
