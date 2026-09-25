import type { JsonValue } from "../core.js";
import {
  decodeEnvelope,
  type EnvelopeKeyResolver,
} from "../envelope.js";
import { scopeStoragePrefix } from "../trie-protocol.js";
import type { TrieReadBundle } from "../trie-protocol.js";

export type RemoteJsonObject =
  | {
      status: "found";
      key: string;
      etag: string;
      value: JsonValue;
      bytes: number;
    }
  | {
      status: "not-modified";
      key: string;
      etag: string;
    }
  | {
      status: "missing";
      key: string;
    };

export interface JsonObjectReader {
  get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject>;
}

export type RemoteByteObject =
  | {
      status: "found";
      key: string;
      etag: string;
      bytes: Uint8Array;
    }
  | {
      status: "not-modified";
      key: string;
      etag: string;
    }
  | {
      status: "missing";
      key: string;
    };

export interface ByteObjectReader {
  get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteByteObject>;
}

export type RemoteReadBundle =
  | {
      status: "found";
      bundle: TrieReadBundle;
      bytes: number;
    }
  | {
      status: "fallback";
    };

export interface PointReadBundleReader {
  get(
    collection: string,
    id: string,
  ): Promise<RemoteReadBundle>;
}

export class HttpObjectReadError extends Error {
  constructor(
    readonly status: number,
    readonly key: string,
  ) {
    super(`Object read failed with ${status} for ${key}`);
    this.name = "HttpObjectReadError";
  }
}

export class HttpByteObjectReader implements ByteObjectReader {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly origin = globalThis.location?.href ??
      "http://127.0.0.1/",
  ) {}

  async get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteByteObject> {
    const headers = new Headers();
    if (ifNoneMatch) {
      headers.set("If-None-Match", quoteHttpEtag(ifNoneMatch));
    }

    function quoteHttpEtag(etag: string): string {
      const trimmed = etag.trim();
      if (
        trimmed.startsWith('"') ||
        trimmed.startsWith("W/\"")
      ) {
        return trimmed;
      }
      return `"${trimmed.replace(/^W\//, "").replace(/^"|"$/g, "")}"`;
    }
    const response = await this.fetchImplementation.call(
      globalThis,
      objectUrl(this.baseUrl, key, this.origin),
      { headers },
    );

    if (response.status === 304) {
      return {
        status: "not-modified",
        key,
        etag: response.headers.get("etag") ?? ifNoneMatch ?? "",
      };
    }
    if (response.status === 404) {
      return { status: "missing", key };
    }
    if (!response.ok) {
      throw new HttpObjectReadError(response.status, key);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const etag = response.headers.get("etag");
    if (!etag) {
      throw new Error(`Object response is missing an ETag for ${key}`);
    }
    return {
      status: "found",
      key,
      etag,
      bytes,
    };
  }
}

export class HttpPointReadBundleReader
implements PointReadBundleReader {
  constructor(
    private readonly baseUrl: string,
    private readonly scopeId: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly origin = globalThis.location?.href ??
      "http://127.0.0.1/",
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<RemoteReadBundle> {
    const url = new URL(this.baseUrl, this.origin);
    url.pathname = [
      url.pathname.replace(/\/+$/, ""),
      encodeURIComponent(this.scopeId),
      encodeURIComponent(collection),
      encodeURIComponent(id),
    ].join("/");
    const response = await this.fetchImplementation.call(
      globalThis,
      url,
      {
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    if (
      response.status === 404 ||
      response.status === 409 ||
      response.status === 413
    ) {
      return { status: "fallback" };
    }
    if (!response.ok) {
      throw new HttpObjectReadError(
        response.status,
        `bundle:${collection}/${id}`,
      );
    }
    const body = await response.text();
    const bundle = readBundleFromJson(JSON.parse(body) as unknown);
    if (
      bundle.collection !== collection ||
      bundle.id !== id
    ) {
      throw new Error(
        "Read bundle does not match the requested document",
      );
    }
    return {
      status: "found",
      bundle,
      bytes: new TextEncoder().encode(body).byteLength,
    };
  }
}

export class EnvelopeJsonObjectReader implements JsonObjectReader {
  constructor(
    private readonly delegate: ByteObjectReader,
    private readonly resolveKey?: EnvelopeKeyResolver,
  ) {}

  async get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject> {
    const result = await this.delegate.get(key, ifNoneMatch);
    if (result.status !== "found") {
      return result;
    }
    const plaintext = await decodeEnvelope(
      result.bytes,
      this.resolveKey,
      new TextEncoder().encode(key),
    );
    return {
      status: "found",
      key,
      etag: result.etag,
      value: JSON.parse(
        new TextDecoder().decode(plaintext),
      ) as JsonValue,
      bytes: result.bytes.byteLength,
    };
  }
}

export class ScopedJsonObjectReader implements JsonObjectReader {
  private readonly prefix: string;

  constructor(
    private readonly delegate: JsonObjectReader,
    scopeId: string,
  ) {
    this.prefix = scopeStoragePrefix(scopeId);
  }

  async get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject> {
    const result = await this.delegate.get(
      `${this.prefix}/${key}`,
      ifNoneMatch,
    );
    return { ...result, key };
  }
}

export class HttpJsonObjectReader implements JsonObjectReader {
  private readonly delegate: HttpByteObjectReader;

  constructor(
    baseUrl: string,
    fetchImplementation: typeof fetch = fetch,
    origin = globalThis.location?.href ?? "http://127.0.0.1/",
  ) {
    this.delegate = new HttpByteObjectReader(
      baseUrl,
      fetchImplementation,
      origin,
    );
  }

  async get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject> {
    const result = await this.delegate.get(key, ifNoneMatch);
    if (result.status !== "found") {
      return result;
    }
    return {
      status: "found",
      key,
      etag: result.etag,
      value: JSON.parse(
        new TextDecoder().decode(result.bytes),
      ) as JsonValue,
      bytes: result.bytes.byteLength,
    };
  }
}

export function objectUrl(
  baseUrl: string,
  key: string,
  origin: string,
): string {
  const url = new URL(baseUrl, origin);
  const query = url.search;
  url.search = "";
  const basePath = url.pathname.replace(/\/+$/, "");
  const objectPath = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  url.pathname = `${basePath}/${objectPath}`;
  url.search = query;
  return url.toString();
}

function readBundleFromJson(value: unknown): TrieReadBundle {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("collection" in value) ||
    typeof value.collection !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !("objects" in value) ||
    !Array.isArray(value.objects) ||
    !value.objects.every(
      (object) =>
        typeof object === "object" &&
        object !== null &&
        !Array.isArray(object) &&
        "key" in object &&
        typeof object.key === "string" &&
        "etag" in object &&
        typeof object.etag === "string" &&
        "value" in object,
    ) ||
    !("document" in value) ||
    (value.document !== null &&
      (typeof value.document !== "object" ||
        Array.isArray(value.document))) ||
    ("layout" in value &&
      value.layout !== "trie" &&
      value.layout !== "snapshot")
  ) {
    throw new Error("Read bundle response is malformed");
  }
  return value as TrieReadBundle;
}
