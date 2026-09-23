import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonDocument, ObjectStore } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import {
  validateAzureReadBaseUrl,
  validateGenericReadBaseUrl,
} from "./server-config.js";
import {
  loadScopeMaterial,
  scopeKeyResponse,
  type ScopeMaterial,
} from "./server-keys.js";
import {
  DemoSessionAuthorizer,
  UnauthorizedError,
} from "./server-session.js";
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

type ServerContext = {
  provider: "local" | "azure" | "s3" | "r2";
  rootStore: ObjectStore;
  engine: ContentAddressedTrieEngine;
  readBaseUrl: string;
  headTtlMs: number;
  scope: ScopeMaterial;
  sessions: DemoSessionAuthorizer;
};

const host = process.env.THIMBLE_HOST ?? "127.0.0.1";
const port = parseInteger(process.env.THIMBLE_PORT, 8787);
const context = await createContext();
const server = createServer((request, response) => {
  void handleRequest(context, request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, error instanceof UnauthorizedError ? 401 : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      response.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(
    `ThimbleDB write authority listening on http://${host}:${port} (${context.provider})`,
  );
});

async function createContext(): Promise<ServerContext> {
  const provider =
    process.env.THIMBLE_PROVIDER ??
    (process.env.AZURE_STORAGE_CONNECTION_STRING ? "azure" : "local");
  if (
    provider !== "local" &&
    provider !== "azure" &&
    provider !== "s3" &&
    provider !== "r2"
  ) {
    throw new Error(`Unsupported THIMBLE_PROVIDER: ${provider}`);
  }

  const container =
    process.env.AZURE_STORAGE_CONTAINER ?? "thimbledb";
  const prefix = process.env.THIMBLE_PREFIX ?? "demo";
  let baseStore: ObjectStore;
  let readBaseUrl: string;
  if (provider === "azure") {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error(
        "AZURE_STORAGE_CONNECTION_STRING is required for the Azure provider",
      );
    }
    baseStore = new AzureBlobObjectStore(
      connectionString,
      container,
    );
    const configuredReadBaseUrl =
      process.env.THIMBLE_READ_BASE_URL ?? "";
    if (!configuredReadBaseUrl) {
      throw new Error(
        "THIMBLE_READ_BASE_URL is required for Azure browser reads",
      );
    }
    readBaseUrl = validateAzureReadBaseUrl(
      configuredReadBaseUrl,
      container,
      prefix,
    );
  } else if (provider === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error("S3_BUCKET is required for the S3 provider");
    }
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
        process.env.S3_FORCE_PATH_STYLE.toLowerCase() === "true";
    }
    baseStore = new S3ObjectStore({ bucket, clientConfig });
    readBaseUrl = requiredGenericReadBaseUrl();
  } else if (provider === "r2") {
    const bucket = process.env.R2_BUCKET;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required for the R2 provider",
      );
    }
    baseStore = new S3ObjectStore({
      bucket,
      clientConfig: {
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      },
    });
    readBaseUrl = requiredGenericReadBaseUrl();
  } else {
    baseStore = new LocalObjectStore(path.resolve(".thimble-data"));
    readBaseUrl = "/objects";
  }

  const rootStore = new PrefixObjectStore(baseStore, prefix);
  const scope = await loadScopeMaterial({
    scopeId: process.env.THIMBLE_SCOPE_ID ?? "demo-user",
    encrypted: process.env.THIMBLE_SCOPE_MODE !== "public",
    keyVersion: parseInteger(process.env.THIMBLE_KEY_VERSION, 1),
    local: provider === "local",
  });
  const scopedStore = new PrefixObjectStore(
    rootStore,
    `scopes/${scope.scopeId}`,
  );
  const store = new EnvelopeObjectStore(
    scopedStore,
    scope.encrypted
      ? {
          key: scope.key!,
          keyId: scope.keyId!,
          compression: "gzip",
          objectKeyPrefix: `scopes/${scope.scopeId}`,
        }
      : {
          compression: "gzip",
          objectKeyPrefix: `scopes/${scope.scopeId}`,
        },
  );
  return {
    provider,
    rootStore,
    engine: new ContentAddressedTrieEngine(
      store,
      40,
      scope.addressNode,
    ),
    readBaseUrl,
    headTtlMs: parseInteger(process.env.THIMBLE_HEAD_TTL_MS, 1_000),
    scope,
    sessions: new DemoSessionAuthorizer(
      scope.scopeId,
      process.env.THIMBLE_SESSION_SECRET ??
        (provider === "local"
          ? randomBytes(48).toString("base64url")
          : requiredSessionSecret()),
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

  if (request.method === "GET" && url.pathname === "/api/config") {
    context.sessions.ensure(request, response);
    sendJson(response, 200, {
      name: "ThimbleDB",
      provider: context.provider,
      readBaseUrl: context.readBaseUrl,
      headTtlMs: context.headTtlMs,
      cachePolicy: "content",
      scope: {
        id: context.scope.scopeId,
        encrypted: context.scope.encrypted,
        keyId: context.scope.keyId,
        keyEndpoint: context.scope.encrypted
          ? `/api/keys/${encodeURIComponent(context.scope.scopeId)}`
          : null,
      },
    });
    return;
  }

  const keyRoute = matchKeyRoute(url.pathname);
  if (request.method === "GET" && keyRoute) {
    context.sessions.require(request, keyRoute.scopeId);
    if (
      !context.scope.encrypted ||
      keyRoute.scopeId !== context.scope.scopeId
    ) {
      sendJson(response, 404, { error: "Encrypted scope not found" });
      return;
    }
    sendJson(response, 200, scopeKeyResponse(context.scope));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/seed") {
    context.sessions.require(request, context.scope.scopeId);
    const profile =
      url.searchParams.get("profile") === "small"
        ? workloadProfiles.small
        : workloadProfiles.tiny;
    const dataset = generateStoreDataset(profile);
    await context.engine.putMany("products", dataset.products);
    await context.engine.putMany("customers", dataset.customers);
    await context.engine.putMany("orders", dataset.orders);
    sendJson(response, 200, {
      profile: profile.name,
      products: dataset.products.length,
      customers: dataset.customers.length,
      orders: dataset.orders.length,
    });
    return;
  }

  const writeRoute = matchWriteRoute(url.pathname);
  if (request.method === "POST" && writeRoute) {
    context.sessions.require(request, context.scope.scopeId);
    const body = await readJsonBody(request);
    const document = asDocument(body, writeRoute.id);
    await context.engine.put(
      writeRoute.collection,
      writeRoute.id,
      document,
    );
    sendJson(
      response,
      200,
      await context.engine.readBundle(
        writeRoute.collection,
        writeRoute.id,
      ),
    );
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/objects/")
  ) {
    if (context.provider !== "local") {
      sendJson(response, 404, {
        error: "Cloud browser reads use THIMBLE_READ_BASE_URL directly",
      });
      return;
    }
    const key = decodeObjectPath(url.pathname.slice("/objects/".length));
    const object = await context.rootStore.get(key);
    if (object === null) {
      response.writeHead(404).end();
      return;
    }
    const responseEtag = httpEtag(object.etag);
    if (
      sameEtag(request.headers["if-none-match"], responseEtag)
    ) {
      response.writeHead(304, { etag: responseEtag }).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/vnd.thimbledb.object",
      "content-length": object.bytes.byteLength,
      "cache-control": "no-cache",
      etag: responseEtag,
    });
    response.end(Buffer.from(object.bytes));
    return;
  }

  function matchKeyRoute(
    pathname: string,
  ): { scopeId: string } | null {
    const match = /^\/api\/keys\/([^/]+)$/.exec(pathname);
    return match?.[1]
      ? { scopeId: decodeURIComponent(match[1]) }
      : null;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (await serveBrowserAsset(url.pathname, request.method, response)) {
      return;
    }
  }

  sendJson(response, 404, { error: "Not found" });
}

function matchWriteRoute(
  pathname: string,
): { collection: string; id: string } | null {
  const match =
    /^\/api\/collections\/([^/]+)\/documents\/([^/]+)$/.exec(
      pathname,
    );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    collection: decodeURIComponent(match[1]),
    id: decodeURIComponent(match[2]),
  };
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) {
      throw new Error("Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function asDocument(value: unknown, id: string): JsonDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Document must be a JSON object");
  }
  const document = value as Record<string, unknown>;
  if (document.id !== id) {
    throw new Error("Document id must match the route id");
  }
  return document as JsonDocument;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
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
      "content-type": mimeType(filePath),
      "content-length": bytes.byteLength,
      "cache-control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    if (method === "HEAD") {
      response.end();
    } else {
      response.end(bytes);
    }
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

function requiredGenericReadBaseUrl(): string {
  const value = process.env.THIMBLE_READ_BASE_URL;
  if (!value) {
    throw new Error(
      "THIMBLE_READ_BASE_URL is required for cloud browser reads",
    );
  }
  return validateGenericReadBaseUrl(value);
}

function requiredSessionSecret(): string {
  throw new Error(
    "THIMBLE_SESSION_SECRET is required for cloud providers",
  );
}
