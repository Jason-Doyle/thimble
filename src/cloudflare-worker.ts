import {
  AuthError,
  AuthService,
  type AuthenticatedSession,
} from "./auth/service.js";
import {
  createEntraAdapter,
  OidcIdentityAdapter,
} from "./auth/oidc.js";
import { DefaultScopeAuthorizer } from "./auth/policy.js";
import type {
  AuthRateLimiter,
  RateLimitResult,
} from "./auth/rate-limit.js";
import {
  ObjectStoreAuthRateLimiter,
  RoutedAuthRateLimiter,
} from "./auth/rate-limit.js";
import { AuthRepository } from "./auth/repository.js";
import type {
  AuthUser,
  Identity,
  IdentityAdapter,
  ScopeGrant,
} from "./auth/types.js";
import { AsyncLruCache } from "./async-lru-cache.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "./cloudflare/r2-object-store.js";
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
import {
  discoverStudioCollections,
  inspectStudioIndex,
  rebuildStudioIndexes,
  STUDIO_API_VERSION,
  StudioLimitError,
  studioCollectionCatalog,
  studioCollectionExport,
  studioDeletedDocuments,
  studioScopes,
} from "./studio-api.js";

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type CloudflareAuthorityEnv = {
  DB: R2BucketBinding;
  AUTH_DB: R2BucketBinding;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  THIMBLE_MASTER_KEY: string;
  THIMBLE_ALLOWED_ORIGIN: string;
  THIMBLE_PREFIX?: string;
  THIMBLE_KEY_VERSION?: string;
  THIMBLE_READ_KEY_VERSIONS?: string;
  THIMBLE_HEAD_TTL_MS?: string;
  THIMBLE_COLLECTION_LAYOUTS?: string;
  THIMBLE_COLLECTION_INDEXES?: string;
  THIMBLE_DELETE_RETENTION_DAYS?: string;
  THIMBLE_DELETE_GRACE_DAYS?: string;
  THIMBLE_MAINTENANCE_MODE?: string;
  THIMBLE_STUDIO?: string;
  THIMBLE_STUDIO_ORIGIN?: string;
  THIMBLE_COLLECTIONS?: string;
  ENTRA_TENANT_ID?: string;
  ENTRA_AUDIENCE?: string;
  ENTRA_REQUIRED_SCOPE?: string;
  ENTRA_REQUIRED_ROLE?: string;
  OIDC_PROVIDER_ID?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  OIDC_JWKS_URI?: string;
  OIDC_ALLOWED_TENANTS?: string;
  OIDC_REQUIRED_SCOPE?: string;
  OIDC_REQUIRED_ROLE?: string;
};

type Env = CloudflareAuthorityEnv;

type ScopeRuntime = {
  material: WorkerScopeMaterial;
  materials: WorkerScopeMaterial[];
  store: ObjectStore;
  trie: ContentAddressedTrieEngine;
  snapshot: ImmutableSnapshotEngine;
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
  deletionPolicy: DeletionPolicy;
  collectionLayouts: Record<string, CollectionLayout>;
  collectionIndexes: CollectionIndexConfiguration;
  collections: string[];
  layoutGeneration: string;
  maintenanceMode: boolean;
  studioEnabled: boolean;
  studioOrigin: string | null;
  oidcProviders: string[];
  allowedOrigin: string;
  scope(scopeId: string): Promise<ScopeRuntime>;
};

export type CloudflareAuthorityOptions = {
  collectionLayouts?: Record<string, CollectionLayout>;
  collectionIndexes?: CollectionIndexConfiguration;
  collections?: string[];
  studio?: boolean;
  studioOrigin?: string;
};

export function createCloudflareAuthority(
  options: CloudflareAuthorityOptions = {},
) {
  let runtimePromise: Promise<Runtime> | undefined;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        runtimePromise ??= createRuntime(env, options).catch(
          (error) => {
            runtimePromise = undefined;
            throw error;
          },
        );
        return await route(await runtimePromise, request, env);
      } catch (error) {
        if (!(error instanceof AuthError && error.status < 500)) {
          console.error(error);
        }
        const status = error instanceof AuthError ? error.status : 500;
        const headers = new Headers();
        if (error instanceof AuthError && error.retryAfterSeconds) {
          headers.set(
            "retry-after",
            String(error.retryAfterSeconds),
          );
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
}

const cloudflareAuthority = createCloudflareAuthority();

export default cloudflareAuthority;

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
      oidcProviders: runtime.oidcProviders,
    });
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
      decodePathSegment(oidcRoute[1]),
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
    requireMutationRequest(
      runtime,
      request,
      authenticated?.session.csrfToken,
    );
    await runtime.auth.logout(
      cookieValue(
        request.headers.get("cookie"),
        runtime.auth.cookieName(),
      ),
    );
    return json(
      { loggedOut: true },
      200,
      new Headers({
        "set-cookie": runtime.auth.clearSessionCookie(),
      }),
    );
  }

  const linkRoute =
    /^\/api\/auth\/identities\/([^/]+)\/link$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && linkRoute?.[1]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const user = await runtime.auth.linkIdentity(
      authenticated,
      decodePathSegment(linkRoute[1]),
      bearerToken(request),
      clientRateKey(request),
    );
    return json({ user: storedUserResponse(user) });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/identities/unlink"
  ) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const user = await runtime.auth.unlinkIdentity(
      authenticated,
      identityReference(await readJsonRequest(request)),
    );
    return json(
      { user: storedUserResponse(user) },
      200,
      new Headers({
        "set-cookie": runtime.auth.clearSessionCookie(),
      }),
    );
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/users"
  ) {
    requireAuthenticated(authenticated);
    const users = await runtime.auth.listUsers(authenticated);
    return json({
      users: users.map(storedUserResponse),
    });
  }

  const adminUserRoute =
    /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && adminUserRoute?.[1]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const user = await runtime.auth.administerUser(
      authenticated,
      adminUserRoute[1],
      administrationChanges(await readJsonRequest(request)),
    );
    return json(
      { user: storedUserResponse(user) },
      200,
      user.id === authenticated.user.id
        ? new Headers({
            "set-cookie": runtime.auth.clearSessionCookie(),
          })
        : new Headers(),
    );
  }

  const revokeSessionsRoute =
    /^\/api\/admin\/users\/([0-9a-f-]{36})\/revoke-sessions$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && revokeSessionsRoute?.[1]) {
    requireAuthenticated(authenticated);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    await runtime.auth.revokeUserSessions(
      authenticated,
      revokeSessionsRoute[1],
    );
    return json(
      { revoked: true },
      200,
      revokeSessionsRoute[1] === authenticated.user.id
        ? new Headers({
            "set-cookie": runtime.auth.clearSessionCookie(),
          })
        : new Headers(),
    );
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/studio"
  ) {
    requireStudioEnabled(runtime);
    requireAuthenticated(authenticated);
    return json({
      version: STUDIO_API_VERSION,
      provider: "r2",
      maintenanceMode: runtime.maintenanceMode,
      layoutGeneration: runtime.layoutGeneration,
      user: publicUser(authenticated),
      scopes: studioScopes(authenticated.session.grants),
      isAdministrator:
        authenticated.principal.roles.includes("thimble.admin"),
    });
  }

  const studioCollectionsRoute =
    /^\/api\/studio\/scopes\/([^/]+)\/collections$/.exec(
      url.pathname,
    );
  if (
    request.method === "GET" &&
    studioCollectionsRoute?.[1]
  ) {
    requireStudioEnabled(runtime);
    requireAuthenticated(authenticated);
    const scopeId = decodePathSegment(studioCollectionsRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "read");
    const scope = await runtime.scope(scopeId);
    try {
      const page = await discoverStudioCollections({
        runtime: scope,
        collections: runtime.collections,
        collectionLayouts: runtime.collectionLayouts,
        collectionIndexes: runtime.collectionIndexes,
        offset: studioPageInteger(
          url.searchParams.get("offset"),
          0,
        ),
        limit: studioPageInteger(
          url.searchParams.get("limit"),
          20,
        ),
      });
      return json({
        scopeId,
        ...page,
      });
    } catch (error) {
      throw studioAuthError(error);
    }
  }

  const studioCollectionRoute =
    /^\/api\/studio\/scopes\/([^/]+)\/collections\/([^/]+)\/(deleted|export|rebuild-indexes|purge-deleted)$/.exec(
      url.pathname,
    );
    const studioIndexHealthRoute =
      /^\/api\/studio\/scopes\/([^/]+)\/collections\/([^/]+)\/indexes\/([^/]+)\/health$/.exec(
        url.pathname,
      );
    if (
      request.method === "GET" &&
      studioIndexHealthRoute?.[1] &&
      studioIndexHealthRoute[2] &&
      studioIndexHealthRoute[3]
    ) {
      requireStudioEnabled(runtime);
      requireAuthenticated(authenticated);
      const scopeId = decodePathSegment(studioIndexHealthRoute[1]);
      requireGrant(authenticated.session.grants, scopeId, "read");
      const collection = decodePathSegment(
        studioIndexHealthRoute[2],
      );
      const indexName = decodePathSegment(
        studioIndexHealthRoute[3],
      );
      const definition = runtime.collectionIndexes[
        collection
      ]?.find((candidate) => candidate.name === indexName);
      if (!definition) {
        throw new AuthError(
          404,
          "index_not_found",
          "Configured secondary index was not found",
        );
      }
      const scope = await runtime.scope(scopeId);
      return json({
        scopeId,
        collection,
        index: await inspectStudioIndex({
          runtime: scope,
          collection,
          layout: runtime.collectionLayouts[collection] ?? "trie",
          definition,
        }),
      });
    }
    if (
    request.method === "GET" &&
    studioCollectionRoute?.[1] &&
    studioCollectionRoute[2] &&
    studioCollectionRoute[3] === "deleted"
  ) {
    requireStudioEnabled(runtime);
    requireAuthenticated(authenticated);
    const scopeId = decodePathSegment(studioCollectionRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "read");
    const collection = decodePathSegment(studioCollectionRoute[2]);
    const scope = await runtime.scope(scopeId);
    try {
      return json({
        scopeId,
        collection,
        deleted: await studioDeletedDocuments({
          engine: engineFor(runtime, scope, collection),
          collection,
        }),
      });
    } catch (error) {
      throw studioAuthError(error);
    }
  }
  if (
    request.method === "GET" &&
    studioCollectionRoute?.[1] &&
    studioCollectionRoute[2] &&
    studioCollectionRoute[3] === "export"
  ) {
    requireStudioEnabled(runtime);
    requireAuthenticated(authenticated);
    const scopeId = decodePathSegment(studioCollectionRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "read");
    const collection = decodePathSegment(studioCollectionRoute[2]);
    const scope = await runtime.scope(scopeId);
    try {
      const exported = await studioCollectionExport({
        engine: engineFor(runtime, scope, collection),
        scopeId,
        collection,
      });
      return new Response(exported.ndjson, {
        headers: securityHeaders({
          "content-type":
            "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "content-disposition":
            `attachment; filename="${safeDownloadName(scopeId)}--${collection}.ndjson"`,
          "x-thimble-records": String(exported.manifest.records),
          "x-thimble-sha256": exported.manifest.sha256,
        }),
      });
    } catch (error) {
      throw studioAuthError(error);
    }
  }
  if (
    request.method === "POST" &&
    studioCollectionRoute?.[1] &&
    studioCollectionRoute[2] &&
    studioCollectionRoute[3] === "rebuild-indexes"
  ) {
    requireStudioEnabled(runtime);
    requireAuthenticated(authenticated);
    requireAdministratorSession(authenticated);
    requireMaintenanceMode(runtime);
    requireLayoutGeneration(runtime, request);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const scopeId = decodePathSegment(studioCollectionRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "write");
    const collection = decodePathSegment(studioCollectionRoute[2]);
    const scope = await runtime.scope(scopeId);
    const result = await rebuildStudioIndexes({
      runtime: scope,
      collection,
      layout: runtime.collectionLayouts[collection] ?? "trie",
      collectionIndexes: runtime.collectionIndexes,
      addressNode: scope.material.addressNode,
    });
    return json({
      scopeId,
      collection,
      ...result,
    });
  }
  if (
    request.method === "POST" &&
    studioCollectionRoute?.[1] &&
    studioCollectionRoute[2] &&
    studioCollectionRoute[3] === "purge-deleted"
  ) {
    requireStudioEnabled(runtime);
    requireAuthenticated(authenticated);
    requireAdministratorSession(authenticated);
    requireWritesEnabled(runtime);
    requireLayoutGeneration(runtime, request);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const scopeId = decodePathSegment(studioCollectionRoute[1]);
    requireGrant(authenticated.session.grants, scopeId, "write");
    const collection = decodePathSegment(studioCollectionRoute[2]);
    const scope = await runtime.scope(scopeId);
    const purged = await engineFor(
      runtime,
      scope,
      collection,
    ).purgeDeleted(collection);
    return json({
      scopeId,
      collection,
      purged,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    requireAuthenticated(authenticated);
    const requestedScope = url.searchParams.get("scope");
    const grant = requestedScope
      ? requireGrant(
          authenticated.session.grants,
          requestedScope,
          "read",
        )
      : defaultGrant(authenticated.session.grants);
    const scope = await runtime.scope(grant.scopeId);
    return json({
      name: "ThimbleDB",
      provider: "r2",
      readBaseUrl: "/api/objects",
      headTtlMs: runtime.headTtlMs,
      cachePolicy: "content",
      collectionLayouts: runtime.collectionLayouts,
      collectionIndexes: runtime.collectionIndexes,
      layoutGeneration: runtime.layoutGeneration,
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
    const scopeId = decodePathSegment(keyRoute[1]);
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
      writeKeyId: scope.material.keyId,
      keys: scope.materials
        .filter(
          (
            material,
          ): material is WorkerScopeMaterial & {
            keyId: string;
            rawKey: Uint8Array;
          } => Boolean(material.keyId && material.rawKey),
        )
        .map((material) => ({
          keyId: material.keyId,
          key: bytesToBase64(material.rawKey),
        })),
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
    requireWritesEnabled(runtime);
    requireLayoutGeneration(runtime, request);
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
    await engineFor(runtime, scope, "products").putMany(
      "products",
      dataset.products,
    );
    await engineFor(runtime, scope, "customers").putMany(
      "customers",
      dataset.customers,
    );
    await engineFor(runtime, scope, "orders").putMany(
      "orders",
      dataset.orders,
    );
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
    requireWritesEnabled(runtime);
    requireLayoutGeneration(runtime, request);
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
    const collection = decodePathSegment(restoreRoute[1]);
    const id = decodePathSegment(restoreRoute[2]);
    const engine = engineFor(runtime, scope, collection);
    const restored = await engine.restore(collection, id);
    if (!restored) {
      throw new AuthError(
        404,
        "document_not_restorable",
        "Document cannot be restored",
      );
    }
    return json(await engine.readBundle(collection, id));
  }
  if (
    request.method === "DELETE" &&
    writeRoute?.[1] &&
    writeRoute[2]
  ) {
    requireAuthenticated(authenticated);
    requireWritesEnabled(runtime);
    requireLayoutGeneration(runtime, request);
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
    const collection = decodePathSegment(writeRoute[1]);
    const id = decodePathSegment(writeRoute[2]);
    const engine = engineFor(runtime, scope, collection);
    const deleted = await engine.delete(
      collection,
      id,
      runtime.deletionPolicy,
    );
    if (!deleted) {
      throw new AuthError(
        404,
        "document_not_found",
        "Document was not found",
      );
    }
    return json(await engine.readBundle(collection, id));
  }
  if (request.method === "POST" && writeRoute?.[1] && writeRoute[2]) {
    requireAuthenticated(authenticated);
    requireWritesEnabled(runtime);
    requireLayoutGeneration(runtime, request);
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
    const collection = decodePathSegment(writeRoute[1]);
    const id = decodePathSegment(writeRoute[2]);
    const document = asDocument(
      await readJsonRequest(request),
      id,
    );
    const engine = engineFor(runtime, scope, collection);
    await engine.put(collection, id, document);
    return json(await engine.readBundle(collection, id));
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
    requireMaintenanceMode(runtime);
    requireLayoutGeneration(runtime, request);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const scopeId = decodePathSegment(layoutMigrationRoute[1]);
    const requestBody = layoutMigrationRequest(
      await readJsonRequest(request),
    );
    const scope = await runtime.scope(scopeId);
    const source = engineFor(
      runtime,
      scope,
      requestBody.collection,
    );
    const target =
      requestBody.targetLayout === "snapshot"
        ? scope.snapshot
        : scope.trie;
    if (source === target) {
      return json({
        scopeId,
        collection: requestBody.collection,
        layout: requestBody.targetLayout,
        migrated: 0,
      });
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
    return json({
      scopeId,
      collection: requestBody.collection,
      layout: requestBody.targetLayout,
      migrated: documents.length,
    });
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
    requireWritesEnabled(runtime);
    requireLayoutGeneration(runtime, request);
    requireMutationRequest(
      runtime,
      request,
      authenticated.session.csrfToken,
    );
    const scopeId = decodePathSegment(scopeMaintenanceRoute[1]);
    const collections = collectionList(
      await readJsonRequest(request),
    );
    const scope = await runtime.scope(scopeId);
    const results: Record<string, number> = {};
    for (const collection of collections) {
      results[collection] =
        scopeMaintenanceRoute[2] === "erase"
          ? await engineFor(
              runtime,
              scope,
              collection,
            ).eraseAll(
              collection,
              runtime.deletionPolicy,
            )
          : await engineFor(
              runtime,
              scope,
              collection,
            ).purgeDeleted(collection);
    }

    return json({
      scopeId,
      operation: scopeMaintenanceRoute[2],
      results,
    });
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "not_found" }, 404);
  }
  if (
    env.ASSETS &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return secureAssetResponse(await env.ASSETS.fetch(request));
  }
  return json({ error: "not_found" }, 404);
}

async function createRuntime(
  env: Env,
  options: CloudflareAuthorityOptions,
): Promise<Runtime> {
  const masterKey = base64ToBytes(env.THIMBLE_MASTER_KEY);
  if (masterKey.byteLength < 32) {
    throw new Error(
      "THIMBLE_MASTER_KEY must contain at least 32 bytes",
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
  const adapters = configuredIdentityAdapters(env);
  const rateLimiter = workerRateLimiter(
    env,
    authStore,
    authIndex,
  );
  const auth = new AuthService({
    repository,
    authorizer: new DefaultScopeAuthorizer(),
    rateLimiter,
    identityAdapters: adapters,
    sessionTtlSeconds: 3_600,
    secureCookies: true,
  });
  const collectionLayouts = options.collectionLayouts
    ? validateCollectionLayouts(options.collectionLayouts)
    : configuredCollectionLayouts(env);
  const collectionIndexes = options.collectionIndexes
    ? validateIndexConfiguration(options.collectionIndexes)
    : configuredCollectionIndexes(env);
  const studioEnabled =
    options.studio ?? env.THIMBLE_STUDIO === "true";
  const collections = studioEnabled
    ? studioCollectionCatalog({
        collections:
          options.collections ??
          commaSeparatedValue(env.THIMBLE_COLLECTIONS),
        collectionLayouts,
        collectionIndexes,
      })
    : [];
  const layoutGeneration = (
    await hashText(
      JSON.stringify({
        collectionLayouts,
        collectionIndexes,
      }),
    )
  ).slice(0, 16);
  const cache = new AsyncLruCache<string, ScopeRuntime>({
    maxEntries: 100,
    ttlMs: 15 * 60_000,
    dispose: (runtime) =>
      runtime.materials.forEach((material) =>
        material.rawKey?.fill(0),
      ),
  });
  const scope = (scopeId: string): Promise<ScopeRuntime> => {
    return cache.get(scopeId, () =>
      createScopeRuntime(
        dataRootStore,
        masterKey,
        scopeId,
        configuredKeyVersions(env),
        collectionIndexes,
      ),
    );
  };

  return {
    auth,
    dataRootStore,
    headTtlMs: parseInteger(env.THIMBLE_HEAD_TTL_MS, 1_000),
    deletionPolicy: configuredDeletionPolicy(env),
    collectionLayouts,
    collectionIndexes,
    collections,
    layoutGeneration,
    maintenanceMode: env.THIMBLE_MAINTENANCE_MODE === "true",
    studioEnabled,
    studioOrigin:
      options.studioOrigin ??
      env.THIMBLE_STUDIO_ORIGIN ??
      null,
    oidcProviders: [...adapters.keys()],
    allowedOrigin: env.THIMBLE_ALLOWED_ORIGIN,
    scope,
  };
}

async function createScopeRuntime(
  dataRootStore: ObjectStore,
  masterKey: Uint8Array,
  scopeId: string,
  versions: number[],
  collectionIndexes: CollectionIndexConfiguration,
): Promise<ScopeRuntime> {
  const materials = await Promise.all(
    versions.map((version) =>
      scopeMaterial(masterKey, scopeId, version),
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
      decryptionKeys,
    },
  );
  return {
    material,
    materials,
    store,
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
  const durable = new ObjectStoreAuthRateLimiter(
    authStore,
    authIndex,
  );
  if (!env.AUTH_RATE_LIMITER) {
    return durable;
  }
  const edge: AuthRateLimiter = {
    async consume(key: string): Promise<RateLimitResult> {
      const result = await env.AUTH_RATE_LIMITER!.limit({ key });
      return {
        allowed: result.success,
        retryAfterSeconds: result.success ? 0 : 60,
      };
    },
  };
  return new RoutedAuthRateLimiter(durable, edge);
}

function configuredIdentityAdapters(
  env: Env,
): Map<string, IdentityAdapter> {
  const adapters = new Map<string, IdentityAdapter>();
  if (
    [
      env.ENTRA_TENANT_ID,
      env.ENTRA_AUDIENCE,
      env.ENTRA_REQUIRED_SCOPE,
      env.ENTRA_REQUIRED_ROLE,
    ].some(Boolean)
  ) {
    adapters.set(
      "entra",
      createEntraAdapter({
        tenantId: requiredConfig(
          env.ENTRA_TENANT_ID,
          "ENTRA_TENANT_ID",
        ),
        audience: requiredConfig(
          env.ENTRA_AUDIENCE,
          "ENTRA_AUDIENCE",
        ),
        ...(env.ENTRA_REQUIRED_SCOPE
          ? { requiredScope: env.ENTRA_REQUIRED_SCOPE }
          : {}),
        ...(env.ENTRA_REQUIRED_ROLE
          ? { requiredRole: env.ENTRA_REQUIRED_ROLE }
          : {}),
      }),
    );
  }

  if (
    [
      env.OIDC_PROVIDER_ID,
      env.OIDC_ISSUER,
      env.OIDC_AUDIENCE,
      env.OIDC_JWKS_URI,
      env.OIDC_REQUIRED_SCOPE,
      env.OIDC_REQUIRED_ROLE,
    ].some(Boolean)
  ) {
    const id = validateName(
      requiredConfig(env.OIDC_PROVIDER_ID, "OIDC_PROVIDER_ID"),
      "OIDC provider ID",
    );
    if (adapters.has(id)) {
      throw new Error(`Duplicate OIDC provider ID: ${id}`);
    }
    const allowedTenants = (env.OIDC_ALLOWED_TENANTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    adapters.set(
      id,
      new OidcIdentityAdapter({
        id,
        issuer: requiredConfig(env.OIDC_ISSUER, "OIDC_ISSUER"),
        audience: requiredConfig(
          env.OIDC_AUDIENCE,
          "OIDC_AUDIENCE",
        ),
        jwksUri: requiredConfig(
          env.OIDC_JWKS_URI,
          "OIDC_JWKS_URI",
        ),
        provider: "oidc",
        ...(allowedTenants.length > 0 ? { allowedTenants } : {}),
        ...(env.OIDC_REQUIRED_SCOPE
          ? { requiredScopes: [env.OIDC_REQUIRED_SCOPE] }
          : {}),
        ...(env.OIDC_REQUIRED_ROLE
          ? { requiredRoles: [env.OIDC_REQUIRED_ROLE] }
          : {}),
      }),
    );
  }
  return adapters;
}

function requiredConfig(
  value: string | undefined,
  name: string,
): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireMutationRequest(
  runtime: Runtime,
  request: Request,
  csrfToken?: string,
): void {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    (origin !== runtime.allowedOrigin &&
      (!runtime.studioOrigin ||
        origin !== runtime.studioOrigin))
  ) {
    throw new AuthError(403, "origin_rejected", "Request was rejected");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!isJsonContentType(contentType)) {
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

function asDocument(value: unknown, id: string): JsonDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { id?: unknown }).id !== id ||
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

function requireStudioEnabled(runtime: Runtime): void {
  if (!runtime.studioEnabled) {
    throw new AuthError(
      404,
      "studio_disabled",
      "ThimbleDB Studio is disabled",
    );
  }
}

function studioAuthError(error: unknown): Error {
  return error instanceof StudioLimitError
    ? new AuthError(413, "studio_limit", error.message)
    : error instanceof Error
      ? error
      : new Error(String(error));
}

function studioPageInteger(
  value: string | null,
  fallback: number,
): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AuthError(
      400,
      "invalid_request",
      "Invalid Studio collection page",
    );
  }
  return parsed;
}

function safeDownloadName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function requireWritesEnabled(runtime: Runtime): void {
  if (runtime.maintenanceMode) {
    throw new AuthError(
      503,
      "maintenance_mode",
      "Writes are temporarily disabled",
    );
  }
}

function requireLayoutGeneration(
  runtime: Runtime,
  request: Request,
): void {
  if (
    request.headers.get("x-thimble-layout-generation") !==
    runtime.layoutGeneration
  ) {
    throw new AuthError(
      409,
      "layout_changed",
      "Reload configuration before writing",
    );
  }
}

function requireMaintenanceMode(runtime: Runtime): void {
  if (!runtime.maintenanceMode) {
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

function publicUser(session: AuthenticatedSession) {
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

function clientRateKey(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}

function scopeFromObjectKey(key: string): string {
  const match = /^scopes\/([^/]+)\//.exec(key);
  if (!match?.[1]) {
    throw new AuthError(404, "object_not_found", "Object not found");
  }
  return decodePathSegment(match[1]);
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
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

function configuredKeyVersions(env: Env): number[] {
  const writeVersion = parseInteger(env.THIMBLE_KEY_VERSION, 1);
  const historical = (env.THIMBLE_READ_KEY_VERSIONS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInteger(value, writeVersion));
  return [
    writeVersion,
    ...historical.filter((value) => value !== writeVersion),
  ];
}

function configuredDeletionPolicy(
  env: Env,
): DeletionPolicy {
  const day = 24 * 60 * 60 * 1_000;
  return {
    restoreWindowMs:
      parseInteger(env.THIMBLE_DELETE_RETENTION_DAYS, 30) * day,
    purgeGraceMs:
      parseInteger(env.THIMBLE_DELETE_GRACE_DAYS, 7) * day,
  };
}

function configuredCollectionLayouts(
  env: Env,
): Record<string, CollectionLayout> {
  const layouts = createDictionary<CollectionLayout>();
  for (const entry of (env.THIMBLE_COLLECTION_LAYOUTS ?? "")
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

function configuredCollectionIndexes(
  env: Env,
): CollectionIndexConfiguration {
  return parseIndexConfiguration(
    env.THIMBLE_COLLECTION_INDEXES,
  );
}

function commaSeparatedValue(
  value: string | undefined,
): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function engineFor(
  runtime: Runtime,
  scope: ScopeRuntime,
  collection: string,
): ContentAddressedTrieEngine | ImmutableSnapshotEngine {
  return runtime.collectionLayouts[collection] === "snapshot"
    ? scope.snapshot
    : scope.trie;
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

export async function readJsonRequest(
  request: Request,
): Promise<unknown> {
  const maximumBytes = 1_048_576;
  const declaredLength = Number(
    request.headers.get("content-length"),
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new AuthError(
      413,
      "request_too_large",
      "Request body is too large",
    );
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return {};
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new AuthError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder().decode(bytes) || "{}",
    ) as unknown;
  } catch {
    throw new AuthError(400, "invalid_json", "Invalid JSON");
  }
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
