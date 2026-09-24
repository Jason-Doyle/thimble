import { createHash } from "node:crypto";
import { AsyncLruCache } from "./async-lru-cache.js";
import { nodeClientIp } from "./client-ip.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthError,
  AuthService,
  type AuthenticatedSession,
} from "./auth/service.js";
import {
  createEntraAdapter,
  OidcIdentityAdapter,
} from "./auth/oidc.js";
import {
  DEVELOPMENT_IDENTITY_ADAPTER_ID,
  DEVELOPMENT_IDENTITY_TOKEN,
  DevelopmentIdentityAdapter,
  validateDevelopmentIdentity,
} from "./auth/dev-identity.js";
import { DefaultScopeAuthorizer } from "./auth/policy.js";
import { ObjectStoreAuthRateLimiter } from "./auth/rate-limit.js";
import { AuthRepository } from "./auth/repository.js";
import type {
  AuthUser,
  Identity,
  IdentityAdapter,
  ScopeGrant,
} from "./auth/types.js";
import type {
  DeletionPolicy,
  JsonDocument,
  JsonValue,
  ObjectStore,
} from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { ImmutableSnapshotEngine } from "./engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import {
  loadScopeMaterial,
  scopeKeyResponse,
  type ScopeMaterial,
} from "./server-keys.js";
import {
  PrefixObjectStore,
} from "./stores.js";
import {
  createConfiguredProviderStores,
  parseProvider,
  type Provider,
} from "./providers/configured.js";
import {
  generateStoreDataset,
  workloadProfiles,
} from "./workload.js";
import { scopeStoragePrefix } from "./trie-protocol.js";
import {
  createDictionary,
  stableStringify,
  validateName,
} from "./shared-utils.js";
import type { CollectionLayout } from "./snapshot-protocol.js";
import {
  parseIndexConfiguration,
  validateIndexConfiguration,
  type CollectionIndexConfiguration,
} from "./secondary-index.js";

type ScopeRuntime = {
  material: ScopeMaterial;
  materials: ScopeMaterial[];
  trie: ContentAddressedTrieEngine;
  snapshot: ImmutableSnapshotEngine;
};

type ServerContext = {
  provider: Provider;
  dataRootStore: ObjectStore;
  auth: AuthService;
  allowedOrigin: string;
  headTtlMs: number;
  deletionPolicy: DeletionPolicy;
  collectionLayouts: Record<string, CollectionLayout>;
  collectionIndexes: CollectionIndexConfiguration;
  layoutGeneration: string;
  maintenanceMode: boolean;
  developmentIdentity: boolean;
  oidcProviders: string[];
  scope(scopeId: string): Promise<ScopeRuntime>;
};

export type NodeAuthorityServer = {
  server: Server;
  host: string;
  port: number;
  provider: Provider;
};

export type NodeAuthorityOptions = {
  collectionLayouts?: Record<string, CollectionLayout>;
  collectionIndexes?: CollectionIndexConfiguration;
};

export async function createNodeAuthorityServer(
  options: NodeAuthorityOptions = {},
): Promise<NodeAuthorityServer> {
  const host = process.env.THIMBLE_HOST ?? "127.0.0.1";
  const port = parseInteger(process.env.THIMBLE_PORT, 8787);
  const context = await createContext(options);
  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch((error) => {
      handleServerError(error, response);
    });
  });
  return { server, host, port, provider: context.provider };
}

export async function startNodeAuthority(
  options: NodeAuthorityOptions = {},
): Promise<NodeAuthorityServer> {
  const authority = await createNodeAuthorityServer(options);
  await new Promise<void>((resolve, reject) => {
    authority.server.once("error", reject);
    authority.server.listen(authority.port, authority.host, resolve);
  });
  console.log(
    `ThimbleDB authority listening on http://${authority.host}:${authority.port} (${authority.provider})`,
  );
  return authority;
}

if (isDirectExecution()) {
  await startNodeAuthority();
}

async function createContext(
  options: NodeAuthorityOptions,
): Promise<ServerContext> {
  const provider = providerName();
  const prefix = process.env.THIMBLE_PREFIX ?? "demo";
  const allowedOrigin =
    process.env.THIMBLE_ALLOWED_ORIGIN ??
    (provider === "local"
      ? "http://127.0.0.1:5173"
      : requiredEnvironment("THIMBLE_ALLOWED_ORIGIN"));
  const developmentIdentity = validateDevelopmentIdentity({
    enabled: process.env.THIMBLE_DEV_IDENTITY === "true",
    ...(process.env.NODE_ENV
      ? { nodeEnvironment: process.env.NODE_ENV }
      : {}),
    provider,
    host: process.env.THIMBLE_HOST ?? "127.0.0.1",
    allowedOrigin,
  });
  const stores = await createConfiguredProviderStores(provider);
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
  const identityAdapters = configuredIdentityAdapters(
    developmentIdentity,
  );
  const secureCookies =
    process.env.THIMBLE_SECURE_COOKIES === "true" ||
    provider !== "local";
  const auth = new AuthService({
    repository,
    authorizer: new DefaultScopeAuthorizer(),
    rateLimiter: new ObjectStoreAuthRateLimiter(
      authStore,
      authIndex,
      parseInteger(process.env.THIMBLE_AUTH_RATE_LIMIT, 5),
      parseInteger(process.env.THIMBLE_AUTH_RATE_WINDOW_MS, 60_000),
    ),
    identityAdapters,
    sessionTtlSeconds: parseInteger(
      process.env.THIMBLE_SESSION_TTL_SECONDS,
      3_600,
    ),
    secureCookies,
  });
  const collectionLayouts = options.collectionLayouts
    ? validateCollectionLayouts(options.collectionLayouts)
    : configuredCollectionLayouts();
  const collectionIndexes = options.collectionIndexes
    ? validateIndexConfiguration(options.collectionIndexes)
    : configuredCollectionIndexes();
  const layoutGeneration = createHash("sha256")
    .update(
      JSON.stringify({
        collectionLayouts,
        collectionIndexes,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const scopeCache = new AsyncLruCache<string, ScopeRuntime>({
    maxEntries: parseInteger(
      process.env.THIMBLE_SCOPE_CACHE_MAX,
      100,
    ),
    ttlMs: parseInteger(
      process.env.THIMBLE_SCOPE_CACHE_TTL_MS,
      15 * 60_000,
    ),
    dispose: (runtime) =>
      runtime.materials.forEach((material) =>
        material.rawKey?.fill(0),
      ),
  });
  const scope = (scopeId: string): Promise<ScopeRuntime> => {
    return scopeCache.get(scopeId, () =>
      createScopeRuntime(
        dataRootStore,
        scopeId,
        provider === "local",
        collectionIndexes,
      ),
    );
  };

  return {
    provider,
    dataRootStore,
    auth,
    allowedOrigin,
    headTtlMs: parseInteger(
      process.env.THIMBLE_HEAD_TTL_MS,
      1_000,
    ),
    deletionPolicy: configuredDeletionPolicy(),
    collectionLayouts,
    collectionIndexes,
    layoutGeneration,
    maintenanceMode:
      process.env.THIMBLE_MAINTENANCE_MODE === "true",
    developmentIdentity,
    oidcProviders: [...identityAdapters.keys()].filter(
      (provider) => provider !== DEVELOPMENT_IDENTITY_ADAPTER_ID,
    ),
    scope,
  };
}

async function createScopeRuntime(
  dataRootStore: ObjectStore,
  scopeId: string,
  local: boolean,
  collectionIndexes: CollectionIndexConfiguration,
): Promise<ScopeRuntime> {
  const encrypted = scopeId !== "public";
  const versions = encrypted ? configuredKeyVersions() : [1];
  const materials = await Promise.all(
    versions.map((keyVersion) =>
      loadScopeMaterial({
        scopeId,
        encrypted,
        keyVersion,
        local,
      }),
    ),
  );
  const material = materials[0]!;
  const decryptionKeys = new Map(
    materials.flatMap((candidate) =>
      candidate.keyId && candidate.key
        ? [[candidate.keyId, candidate.key] as const]
        : [],
    ),
  );
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
          decryptionKeys,
        }
      : {
          compression: "gzip",
          objectKeyPrefix: scopeStoragePrefix(scopeId),
        },
  );
  return {
    material,
    materials,
    trie: new ContentAddressedTrieEngine(
      store,
      40,
      material.addressNode,
      false,
      collectionIndexes,
    ),
    snapshot: new ImmutableSnapshotEngine(
      store,
      40,
      material.addressNode,
      false,
      collectionIndexes,
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
      oidcProviders: context.oidcProviders,
      developmentIdentity: context.developmentIdentity,
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/dev/session"
  ) {
    if (!context.developmentIdentity) {
      throw new AuthError(
        404,
        "development_identity_disabled",
        "Development identity is disabled",
      );
    }
    requireMutationRequest(context, request);
    await context.auth.logout(
      sessionCookie(request, context.auth.cookieName()),
    );
    const authenticated = await context.auth.loginExternal(
      DEVELOPMENT_IDENTITY_ADAPTER_ID,
      DEVELOPMENT_IDENTITY_TOKEN,
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
      decodePathSegment(oidcRoute[1]),
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
    requireMutationRequest(
      context,
      request,
      authenticated?.session.csrfToken,
    );
    await context.auth.logout(
      sessionCookie(request, context.auth.cookieName()),
    );
    response.setHeader(
      "set-cookie",
      context.auth.clearSessionCookie(),
    );
    sendJson(response, 200, { loggedOut: true });
    return;
  }

  const linkRoute =
    /^\/api\/auth\/identities\/([^/]+)\/link$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && linkRoute?.[1]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const user = await context.auth.linkIdentity(
      authenticated,
      decodePathSegment(linkRoute[1]),
      bearerToken(request),
      clientRateKey(request),
    );
    sendJson(response, 200, { user: storedUserResponse(user) });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/identities/unlink"
  ) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const user = await context.auth.unlinkIdentity(
      authenticated,
      identityReference(await readJsonBody(request)),
    );
    response.setHeader(
      "set-cookie",
      context.auth.clearSessionCookie(),
    );
    sendJson(response, 200, { user: storedUserResponse(user) });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/users"
  ) {
    requireAuthenticated(authenticated);
    const users = await context.auth.listUsers(authenticated);
    sendJson(response, 200, {
      users: users.map(storedUserResponse),
    });
    return;
  }

  const adminUserRoute =
    /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && adminUserRoute?.[1]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const user = await context.auth.administerUser(
      authenticated,
      adminUserRoute[1],
      administrationChanges(await readJsonBody(request)),
    );
    if (user.id === authenticated.user.id) {
      response.setHeader(
        "set-cookie",
        context.auth.clearSessionCookie(),
      );
    }
    sendJson(response, 200, { user: storedUserResponse(user) });
    return;
  }

  const revokeSessionsRoute =
    /^\/api\/admin\/users\/([0-9a-f-]{36})\/revoke-sessions$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && revokeSessionsRoute?.[1]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    await context.auth.revokeUserSessions(
      authenticated,
      revokeSessionsRoute[1],
    );
    if (revokeSessionsRoute[1] === authenticated.user.id) {
      response.setHeader(
        "set-cookie",
        context.auth.clearSessionCookie(),
      );
    }
    sendJson(response, 200, { revoked: true });
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
      collectionLayouts: context.collectionLayouts,
      collectionIndexes: context.collectionIndexes,
      layoutGeneration: context.layoutGeneration,
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
    const scopeId = decodePathSegment(keyRoute[1]);
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
      scopeId,
      writeKeyId: runtime.material.keyId,
      keys: runtime.materials
        .filter(
          (
            material,
          ): material is ScopeMaterial & {
            keyId: string;
            rawKey: Uint8Array;
          } => Boolean(material.keyId && material.rawKey),
        )
        .map((material) => ({
          keyId: material.keyId,
          key: scopeKeyResponse(material).key,
        })),
      algorithm: "A256GCM",
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
    requireWritesEnabled(context);
    requireLayoutGeneration(context, request);
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
    await engineFor(context, runtime, "products").putMany(
      "products",
      dataset.products,
    );
    await engineFor(context, runtime, "customers").putMany(
      "customers",
      dataset.customers,
    );
    await engineFor(context, runtime, "orders").putMany(
      "orders",
      dataset.orders,
    );
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
  const restoreRoute =
    /^\/api\/collections\/([^/]+)\/documents\/([^/]+)\/restore$/.exec(
      url.pathname,
    );
  if (
    request.method === "POST" &&
    restoreRoute?.[1] &&
    restoreRoute[2]
  ) {
    requireAuthenticated(authenticated);
    requireWritesEnabled(context);
    requireLayoutGeneration(context, request);
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
    const collection = decodePathSegment(restoreRoute[1]);
    const id = decodePathSegment(restoreRoute[2]);
    const engine = engineFor(context, runtime, collection);
    const restored = await engine.restore(collection, id);
    if (!restored) {
      throw new AuthError(
        404,
        "document_not_restorable",
        "Document cannot be restored",
      );
    }
    sendJson(
      response,
      200,
      await engine.readBundle(collection, id),
    );
    return;
  }
  if (
    request.method === "DELETE" &&
    writeRoute?.[1] &&
    writeRoute[2]
  ) {
    requireAuthenticated(authenticated);
    requireWritesEnabled(context);
    requireLayoutGeneration(context, request);
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
    const collection = decodePathSegment(writeRoute[1]);
    const id = decodePathSegment(writeRoute[2]);
    const engine = engineFor(context, runtime, collection);
    const deleted = await engine.delete(
      collection,
      id,
      context.deletionPolicy,
    );
    if (!deleted) {
      throw new AuthError(
        404,
        "document_not_found",
        "Document was not found",
      );
    }
    sendJson(
      response,
      200,
      await engine.readBundle(collection, id),
    );
    return;
  }
  if (request.method === "POST" && writeRoute?.[1] && writeRoute[2]) {
    requireAuthenticated(authenticated);
    requireWritesEnabled(context);
    requireLayoutGeneration(context, request);
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
    const collection = decodePathSegment(writeRoute[1]);
    const id = decodePathSegment(writeRoute[2]);
    const document = asDocument(await readJsonBody(request), id);
    const engine = engineFor(context, runtime, collection);
    await engine.put(collection, id, document);
    sendJson(
      response,
      200,
      await engine.readBundle(collection, id),
    );
    return;
  }

  const layoutMigrationRoute =
    /^\/api\/admin\/scopes\/([^/]+)\/migrate-layout$/.exec(
      url.pathname,
    );
  if (
    request.method === "POST" &&
    layoutMigrationRoute?.[1]
  ) {
    requireAuthenticated(authenticated);
    requireAdministratorSession(authenticated);
    requireMaintenanceMode(context);
    requireLayoutGeneration(context, request);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const scopeId = decodePathSegment(layoutMigrationRoute[1]);
    const requestBody = layoutMigrationRequest(
      await readJsonBody(request),
    );
    const runtime = await context.scope(scopeId);
    const source = engineFor(
      context,
      runtime,
      requestBody.collection,
    );
    const target =
      requestBody.targetLayout === "snapshot"
        ? runtime.snapshot
        : runtime.trie;
    if (source === target) {
      sendJson(response, 200, {
        scopeId,
        collection: requestBody.collection,
        layout: requestBody.targetLayout,
        migrated: 0,
      });
      return;
    }
    if (
      (await source.retainedDeletionCount(
        requestBody.collection,
      )) > 0
    ) {
      throw new AuthError(
        409,
        "retained_deletions",
        "Resolve retained deletions before changing layout",
      );
    }
    const documents = await source.exportStored(
      requestBody.collection,
    );
    await target.replaceStored(requestBody.collection, documents);
    const verified = await target.exportStored(
      requestBody.collection,
    );
    if (
      stableStringify(verified as unknown as JsonValue) !==
      stableStringify(documents as unknown as JsonValue)
    ) {
      throw new Error("Target layout verification failed");
    }
    sendJson(response, 200, {
      scopeId,
      collection: requestBody.collection,
      layout: requestBody.targetLayout,
      migrated: documents.length,
    });
    return;
  }

  const scopeMaintenanceRoute =
    /^\/api\/admin\/scopes\/([^/]+)\/(erase|purge-deleted)$/.exec(
      url.pathname,
    );
  if (
    request.method === "POST" &&
    scopeMaintenanceRoute?.[1] &&
    scopeMaintenanceRoute[2]
  ) {
    requireAuthenticated(authenticated);
    requireAdministratorSession(authenticated);
    requireWritesEnabled(context);
    requireLayoutGeneration(context, request);
    requireMutationRequest(
      context,
      request,
      authenticated.session.csrfToken,
    );
    const scopeId = decodePathSegment(scopeMaintenanceRoute[1]);
    const collections = collectionList(await readJsonBody(request));
    const runtime = await context.scope(scopeId);
    const results: Record<string, number> = {};
    for (const collection of collections) {
      results[collection] =
        scopeMaintenanceRoute[2] === "erase"
          ? await engineFor(
              context,
              runtime,
              collection,
            ).eraseAll(
              collection,
              context.deletionPolicy,
            )
          : await engineFor(
              context,
              runtime,
              collection,
            ).purgeDeleted(collection);
    }

    sendJson(response, 200, {
      scopeId,
      operation: scopeMaintenanceRoute[2],
      results,
    });
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
  if (!isJsonContentType(contentType)) {
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
  return decodePathSegment(match[1]);
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
    (value as Record<string, unknown>).id !== id ||
    "__thimbleTombstone" in value
  ) {
    throw new AuthError(
      400,
      "invalid_document",
      "Document id must match the route id",
    );
  }
  return value as JsonDocument;
}

function requireAdministratorSession(
  authenticated: AuthenticatedSession,
): void {
  if (!authenticated.principal.roles.includes("thimble.admin")) {
    throw new AuthError(403, "administrator_required", "Access denied");
  }
}

function requireWritesEnabled(context: ServerContext): void {
  if (context.maintenanceMode) {
    throw new AuthError(
      503,
      "maintenance_mode",
      "Writes are temporarily disabled",
    );
  }
}

function requireLayoutGeneration(
  context: ServerContext,
  request: IncomingMessage,
): void {
  if (
    headerValue(
      request.headers["x-thimble-layout-generation"],
    ) !== context.layoutGeneration
  ) {
    throw new AuthError(
      409,
      "layout_changed",
      "Reload configuration before writing",
    );
  }
}

function requireMaintenanceMode(context: ServerContext): void {
  if (!context.maintenanceMode) {
    throw new AuthError(
      409,
      "maintenance_required",
      "Enable maintenance mode before changing collection layout",
    );
  }
}

function collectionList(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray(
      (value as { collections?: unknown }).collections,
    )
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return stringList(
    (value as { collections: unknown[] }).collections,
  );
}

function layoutMigrationRequest(value: unknown): {
  collection: string;
  targetLayout: CollectionLayout;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.collection !== "string" ||
    (candidate.targetLayout !== "trie" &&
      candidate.targetLayout !== "snapshot")
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return {
    collection: validateName(candidate.collection, "Collection"),
    targetLayout: candidate.targetLayout,
  };
}

function publicUser(session: AuthenticatedSession): {
  id: string;
  provider: string;
  roles: string[];
  tenants: string[];
  identities: Array<{
    provider: string;
    issuer: string;
    subject: string;
  }>;
} {
  return {
    id: session.user.id,
    provider: session.principal.provider,
    roles: [...session.principal.roles],
    tenants: [...session.principal.tenantIds],
    identities: session.user.identities.map(identityResponse),
  };
}

function storedUserResponse(user: AuthUser) {
  return {
    id: user.id,
    status: user.status,
    authVersion: user.authVersion,
    roles: [...user.roles],
    tenants: [...user.tenants],
    identities: user.identities.map((identity) => ({
      ...identityResponse(identity),
      roles: [...identity.roles],
      tenants: [...identity.tenants],
    })),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function identityResponse(identity: Identity) {
  return {
    provider: identity.provider,
    issuer: identity.issuer,
    subject: identity.subject,
  };
}

function identityReference(value: unknown): {
  provider: Identity["provider"];
  issuer: string;
  subject: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.provider !== "entra" &&
      candidate.provider !== "oidc") ||
    typeof candidate.issuer !== "string" ||
    typeof candidate.subject !== "string"
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return {
    provider: candidate.provider,
    issuer: candidate.issuer,
    subject: candidate.subject,
  };
}

function administrationChanges(value: unknown): {
  status?: AuthUser["status"];
  roles?: string[];
  tenants?: string[];
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  const candidate = value as Record<string, unknown>;
  const changes: {
    status?: AuthUser["status"];
    roles?: string[];
    tenants?: string[];
  } = {};
  if (candidate.status !== undefined) {
    if (
      candidate.status !== "active" &&
      candidate.status !== "disabled"
    ) {
      throw new AuthError(400, "invalid_request", "Invalid request");
    }
    changes.status = candidate.status;
  }
  if (candidate.roles !== undefined) {
    changes.roles = stringList(candidate.roles);
  }
  if (candidate.tenants !== undefined) {
    changes.tenants = stringList(candidate.tenants);
  }
  if (Object.keys(changes).length === 0) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return changes;
}

function stringList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 256,
    )
  ) {
    throw new AuthError(400, "invalid_request", "Invalid request");
  }
  return [...new Set(value)].sort();
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

function clientRateKey(request: IncomingMessage): string | null {
  return nodeClientIp(request);
}

function configuredIdentityAdapters(
  developmentIdentity: boolean,
): Map<string, IdentityAdapter> {
  const adapters = new Map<string, IdentityAdapter>();
  if (developmentIdentity) {
    adapters.set(
      DEVELOPMENT_IDENTITY_ADAPTER_ID,
      new DevelopmentIdentityAdapter({
        subject:
          process.env.THIMBLE_DEV_SUBJECT ??
          "local-developer",
        displayName:
          process.env.THIMBLE_DEV_DISPLAY_NAME ??
          "Local developer",
      }),
    );
  }
  if (
    [
      process.env.ENTRA_TENANT_ID,
      process.env.ENTRA_AUDIENCE,
      process.env.ENTRA_REQUIRED_SCOPE,
      process.env.ENTRA_REQUIRED_ROLE,
    ].some(Boolean)
  ) {
    adapters.set(
      "entra",
      createEntraAdapter({
        tenantId: requiredEnvironment("ENTRA_TENANT_ID"),
        audience: requiredEnvironment("ENTRA_AUDIENCE"),
        ...(process.env.ENTRA_REQUIRED_SCOPE
          ? { requiredScope: process.env.ENTRA_REQUIRED_SCOPE }
          : {}),
        ...(process.env.ENTRA_REQUIRED_ROLE
          ? { requiredRole: process.env.ENTRA_REQUIRED_ROLE }
          : {}),
      }),
    );
  }

  if (
    [
      process.env.OIDC_PROVIDER_ID,
      process.env.OIDC_ISSUER,
      process.env.OIDC_AUDIENCE,
      process.env.OIDC_JWKS_URI,
      process.env.OIDC_REQUIRED_SCOPE,
      process.env.OIDC_REQUIRED_ROLE,
    ].some(Boolean)
  ) {
    const id = validateName(
      requiredEnvironment("OIDC_PROVIDER_ID"),
      "OIDC provider ID",
    );
    if (adapters.has(id)) {
      throw new Error(`Duplicate OIDC provider ID: ${id}`);
    }
    const allowedTenants = (
      process.env.OIDC_ALLOWED_TENANTS ?? ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    adapters.set(
      id,
      new OidcIdentityAdapter({
        id,
        issuer: requiredEnvironment("OIDC_ISSUER"),
        audience: requiredEnvironment("OIDC_AUDIENCE"),
        jwksUri: requiredEnvironment("OIDC_JWKS_URI"),
        provider: "oidc",
        ...(allowedTenants.length > 0 ? { allowedTenants } : {}),
        ...(process.env.OIDC_REQUIRED_SCOPE
          ? {
              requiredScopes: [
                process.env.OIDC_REQUIRED_SCOPE,
              ],
            }
          : {}),
        ...(process.env.OIDC_REQUIRED_ROLE
          ? {
              requiredRoles: [process.env.OIDC_REQUIRED_ROLE],
            }
          : {}),
      }),
    );
  }
  return adapters;
}

function providerName(): Provider {
  return parseProvider(
    process.env.THIMBLE_PROVIDER ??
      (process.env.AZURE_STORAGE_CONNECTION_STRING
        ? "azure"
        : "local"),
  );
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
    .map((segment) => decodePathSegment(segment))
    .join("/");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AuthError(400, "invalid_path", "Invalid request path");
  }
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    Boolean(mediaType?.endsWith("+json"))
  );
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
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

function configuredKeyVersions(): number[] {
  const writeVersion = parseInteger(
    process.env.THIMBLE_KEY_VERSION,
    1,
  );
  const historical = (
    process.env.THIMBLE_READ_KEY_VERSIONS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInteger(value, writeVersion));
  return [
    writeVersion,
    ...historical.filter((value) => value !== writeVersion),
  ];
}

function configuredDeletionPolicy(): DeletionPolicy {
  const day = 24 * 60 * 60 * 1_000;
  return {
    restoreWindowMs:
      parseInteger(
        process.env.THIMBLE_DELETE_RETENTION_DAYS,
        30,
      ) * day,
    purgeGraceMs:
      parseInteger(
        process.env.THIMBLE_DELETE_GRACE_DAYS,
        7,
      ) * day,
  };
}

function configuredCollectionLayouts(): Record<
  string,
  CollectionLayout
> {
  const layouts = createDictionary<CollectionLayout>();
  for (const entry of (
    process.env.THIMBLE_COLLECTION_LAYOUTS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [collection, layout, ...extra] = entry.split("=");
    if (
      !collection ||
      !layout ||
      extra.length > 0 ||
      (layout !== "trie" && layout !== "snapshot")
    ) {
      throw new Error(
        `Invalid THIMBLE_COLLECTION_LAYOUTS entry: ${entry}`,
      );
    }

    layouts[validateName(collection, "Collection")] = layout;
  }
  return layouts;
}

function validateCollectionLayouts(
  configured: Record<string, CollectionLayout>,
): Record<string, CollectionLayout> {
  const layouts = createDictionary<CollectionLayout>();
  for (const [collection, layout] of Object.entries(configured)) {
    if (layout !== "trie" && layout !== "snapshot") {
      throw new Error(
        `Invalid collection layout for ${collection}`,
      );
    }
    layouts[validateName(collection, "Collection")] = layout;
  }
  return layouts;
}

function configuredCollectionIndexes(): CollectionIndexConfiguration {
  return parseIndexConfiguration(
    process.env.THIMBLE_COLLECTION_INDEXES,
  );
}

function engineFor(
  context: ServerContext,
  runtime: ScopeRuntime,
  collection: string,
): ContentAddressedTrieEngine | ImmutableSnapshotEngine {
  return context.collectionLayouts[collection] === "snapshot"
    ? runtime.snapshot
    : runtime.trie;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function handleServerError(
  error: unknown,
  response: ServerResponse,
): void {
  if (!(error instanceof AuthError && error.status < 500)) {
    console.error(error);
  }
  if (response.headersSent) {
    response.end();
    return;
  }
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
        error instanceof AuthError ? error.code : "internal_error",
      message:
        error instanceof AuthError ? error.message : "Request failed",
    },
    headers,
  );
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry &&
      path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url)),
  );
}
