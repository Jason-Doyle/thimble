import type { JsonDocument, ObjectStore } from "./core.js";
import { R2ObjectStore, type R2BucketBinding } from "./cloudflare/r2-object-store.js";
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

type Env = {
  DB: R2BucketBinding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  THIMBLE_READ_BASE_URL: string;
  THIMBLE_MASTER_KEY?: string;
  THIMBLE_SESSION_SECRET: string;
  THIMBLE_PREFIX?: string;
  THIMBLE_SCOPE_ID?: string;
  THIMBLE_KEY_VERSION?: string;
  THIMBLE_HEAD_TTL_MS?: string;
  THIMBLE_DEMO_MODE?: string;
  THIMBLE_SCOPE_MODE?: string;
};

type Runtime = {
  engine: ContentAddressedTrieEngine;
  scopeId: string;
  encrypted: boolean;
  keyId: string | null;
  rawKey: Uint8Array | null;
  readBaseUrl: string;
  headTtlMs: number;
};

let runtimePromise: Promise<Runtime> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runtime = await runtimeFor(env);
    const session = await sessionFor(request, env, runtime.scopeId);

    if (request.method === "GET" && url.pathname === "/api/config") {
      if (!session) {
        return json({ error: "Authentication is required" }, 401);
      }
      return json(
        {
          name: "ThimbleDB",
          provider: "r2",
          readBaseUrl: runtime.readBaseUrl,
          headTtlMs: runtime.headTtlMs,
          cachePolicy: "content",
          scope: {
            id: runtime.scopeId,
            encrypted: runtime.encrypted,
            keyId: runtime.keyId,
            keyEndpoint: runtime.encrypted
              ? `/api/keys/${encodeURIComponent(runtime.scopeId)}`
              : null,
          },
        },
        200,
        session.setCookie,
      );
    }

    if (!session) {
      return json({ error: "Authentication is required" }, 401);
    }

    const keyRoute = /^\/api\/keys\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && keyRoute?.[1]) {
      const scopeId = decodeURIComponent(keyRoute[1]);
      if (
        !runtime.encrypted ||
        !runtime.keyId ||
        !runtime.rawKey ||
        scopeId !== runtime.scopeId ||
        scopeId !== session.scopeId
      ) {
        return json({ error: "Scope not found" }, 404);
      }
      return json({
        scopeId,
        keyId: runtime.keyId,
        key: bytesToBase64(runtime.rawKey),
        algorithm: "A256GCM",
      });
    }

    if (request.method === "POST" && url.pathname === "/api/seed") {
      const profile =
        url.searchParams.get("profile") === "small"
          ? workloadProfiles.small
          : workloadProfiles.tiny;
      const dataset = generateStoreDataset(profile);
      await runtime.engine.putMany("products", dataset.products);
      await runtime.engine.putMany("customers", dataset.customers);
      await runtime.engine.putMany("orders", dataset.orders);
      return json({
        profile: profile.name,
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
      const collection = decodeURIComponent(writeRoute[1]);
      const id = decodeURIComponent(writeRoute[2]);
      const document = asDocument(await request.json(), id);
      await runtime.engine.put(collection, id, document);
      return json(await runtime.engine.readBundle(collection, id));
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: "Not found" }, 404);
  },
};

async function runtimeFor(env: Env): Promise<Runtime> {
  runtimePromise ??= createRuntime(env);
  return runtimePromise;
}

async function createRuntime(env: Env): Promise<Runtime> {
  const scopeId = env.THIMBLE_SCOPE_ID ?? "demo-user";
  const version = `v${parsePositiveInteger(env.THIMBLE_KEY_VERSION, 1)}`;
  const encrypted = env.THIMBLE_SCOPE_MODE !== "public";
  const masterKey = encrypted
    ? base64ToBytes(env.THIMBLE_MASTER_KEY ?? "")
    : null;
  if (masterKey && masterKey.byteLength !== 32) {
    throw new Error("THIMBLE_MASTER_KEY must decode to 32 bytes");
  }
  const rawKey = masterKey
    ? await deriveBytes(
        masterKey,
        `encryption:${scopeId}:${version}`,
      )
    : null;
  const addressKey = masterKey
    ? await importHmacKey(
        await deriveBytes(masterKey, `address:${scopeId}:${version}`),
      )
    : null;
  const key = rawKey
    ? await importAesGcmKey(
        rawKey,
        ["encrypt", "decrypt"],
      )
    : null;
  const prefix = env.THIMBLE_PREFIX ?? "demo";
  const rootStore: ObjectStore = new PrefixObjectStore(
    new R2ObjectStore(env.DB),
    prefix,
  );
  const rawScopeStore = new PrefixObjectStore(
    rootStore,
    `scopes/${scopeId}`,
  );
  const scopeStore = new EnvelopeObjectStore(
    rawScopeStore,
    encrypted
      ? {
          key: key!,
          keyId: `${scopeId}:${version}`,
          compression: "gzip",
          objectKeyPrefix: `scopes/${scopeId}`,
        }
      : {
          compression: "gzip",
          objectKeyPrefix: `scopes/${scopeId}`,
        },
  );
  return {
    engine: new ContentAddressedTrieEngine(
      scopeStore,
      40,
      addressKey
        ? async (bytes) => hmacHex(addressKey, bytes)
        : hashHex,
    ),
    scopeId,
    encrypted,
    keyId: encrypted ? `${scopeId}:${version}` : null,
    rawKey,
    readBaseUrl: requireHttpsUrl(env.THIMBLE_READ_BASE_URL),
    headTtlMs: parsePositiveInteger(env.THIMBLE_HEAD_TTL_MS, 1_000),
  };
}

async function hashHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bufferView(bytes),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sessionFor(
  request: Request,
  env: Env,
  scopeId: string,
): Promise<{ scopeId: string; setCookie?: string } | null> {
  const existing = cookieValue(request.headers.get("cookie"), "thimble_session");
  if (existing) {
    const payload = await verifySession(existing, env.THIMBLE_SESSION_SECRET);
    if (payload && payload.scopeId === scopeId && payload.expiresAt > Date.now()) {
      return { scopeId };
    }
  }
  if (env.THIMBLE_DEMO_MODE !== "true") {
    return null;
  }

  const token = await signSession(
    {
      scopeId,
      expiresAt: Date.now() + 60 * 60 * 1_000,
    },
    env.THIMBLE_SESSION_SECRET,
  );
  return {
    scopeId,
    setCookie: [
      `thimble_session=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Max-Age=3600",
    ].join("; "),
  };
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
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    bufferView(bytes),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signSession(
  payload: { scopeId: string; expiresAt: number },
  secret: string,
): Promise<string> {
  const encoded = base64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await signText(encoded, secret);
  return `${encoded}.${base64Url(signature)}`;
}

async function verifySession(
  token: string,
  secret: string,
): Promise<{ scopeId: string; expiresAt: number } | null> {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return null;
  }
  const expected = base64Url(await signText(encoded, secret));
  if (!constantTimeEqual(expected, signature)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    ) as { scopeId?: unknown; expiresAt?: unknown };
    return typeof payload.scopeId === "string" &&
      typeof payload.expiresAt === "number"
      ? { scopeId: payload.scopeId, expiresAt: payload.expiresAt }
      : null;
  } catch {
    return null;
  }
}

async function signText(
  value: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(value),
    ),
  );
}

function asDocument(value: unknown, id: string): JsonDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { id?: unknown }).id !== id
  ) {
    throw new Error("Document must be a JSON object whose id matches the route");
  }
  return value as JsonDocument;
}

function json(
  value: unknown,
  status = 200,
  setCookie?: string,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (setCookie) {
    headers.set("set-cookie", setCookie);
  }
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers,
  });
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

function requireHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("THIMBLE_READ_BASE_URL must use HTTPS");
  }
  return url.toString();
}

function parsePositiveInteger(
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}
