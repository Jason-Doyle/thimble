import { describe, expect, it } from "vitest";
import {
  createThimbleConnection,
  createThimbleClient,
  MemoryObjectCache,
  ThimbleClient,
  type CachedJsonObject,
} from "../src/index.js";

describe("browser connection factory", () => {
  it("creates a ready client from authority configuration", async () => {
    const requests: string[] = [];
    const connection = await createThimbleConnection({
      configurationUrl: "https://app.example.test/api/config",
      persistentCache: false,
      fetchImplementation: async (input) => {
        requests.push(String(input));
        return Response.json(browserConfig(false));
      },
    });

    expect(connection.client).toBeInstanceOf(ThimbleClient);
    expect(connection.config.scope.id).toBe("user:user-1");
    expect(connection.cache.metrics().policy).toBe("content");
    expect(requests).toEqual([
      "https://app.example.test/api/config",
    ]);
  });

  it("imports encrypted scope grants", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const requests: string[] = [];
    const client = await createThimbleClient({
      configurationUrl: "https://app.example.test/api/config",
      persistentCache: false,
      fetchImplementation: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/api/config")) {
          return Response.json(browserConfig(true));
        }
        if (url.endsWith("/api/keys/user%3Auser-1")) {
          return Response.json({
            scopeId: "user:user-1",
            writeKeyId: "scope-v1",
            algorithm: "A256GCM",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            keys: [
              {
                keyId: "scope-v1",
                key: Buffer.from(rawKey).toString("base64"),
              },
            ],
          });
        }
        return new Response(null, { status: 404 });
      },
    });

    expect(client).toBeInstanceOf(ThimbleClient);
    expect(requests).toEqual([
      "https://app.example.test/api/config",
      "https://app.example.test/api/keys/user%3Auser-1",
    ]);
  });

  it("targets mutations at the configured authority origin", async () => {
    const requests: string[] = [];
    const client = await createThimbleClient({
      configurationUrl:
        "https://authority.example.test/custom/api/config",
      persistentCache: false,
      fetchImplementation: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/custom/api/config")) {
          return Response.json({
            ...browserConfig(false),
            collectionLayouts: {
              notes: "trie",
            },
          });
        }
        if (url.includes("/api/collections/notes/documents/note-1")) {
          return Response.json({
            collection: "notes",
            id: "note-1",
            revision: 1,
            document: {
              id: "note-1",
              title: "Authority",
            },
            objects: [],
          });
        }
        return new Response(null, { status: 404 });
      },
    });

    await client.write("notes", "note-1", {
      id: "note-1",
      title: "Authority",
    });

    expect(requests.at(-1)).toBe(
      "https://authority.example.test/api/collections/notes/documents/note-1",
    );
    client.close();
  });

  it("rejects malformed authority configuration", async () => {
    await expect(
      createThimbleClient({
        configurationUrl: "https://app.example.test/api/config",
        persistentCache: false,
        fetchImplementation: () =>
          Promise.resolve(Response.json({ name: "invalid" })),
      }),
    ).rejects.toThrow("configuration is malformed");

    await expect(
      createThimbleClient({
        configurationUrl: "https://app.example.test/api/config",
        persistentCache: false,
        fetchImplementation: () =>
          Promise.resolve(
            Response.json({
              ...browserConfig(false),
              collectionLayouts: [],
            }),
          ),
      }),
    ).rejects.toThrow("configuration is malformed");
  });

  it("rejects duplicate scope keys", async () => {
    const key = Buffer.alloc(32).toString("base64");
    await expect(
      createThimbleClient({
        configurationUrl: "https://app.example.test/api/config",
        persistentCache: false,
        fetchImplementation: async (input) => {
          if (String(input).endsWith("/api/config")) {
            return Response.json(browserConfig(true));
          }
          return Response.json({
            scopeId: "user:user-1",
            writeKeyId: "scope-v1",
            algorithm: "A256GCM",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            keys: [
              {
                keyId: "scope-v1",
                key,
              },
              {
                keyId: "scope-v1",
                key,
              },
            ],
          });
        },
      }),
    ).rejects.toThrow("duplicate keys");
  });

  it("isolates reused custom memory caches by scope", async () => {
    const memoryCache = new MemoryObjectCache();
    const first = await createThimbleConnection({
      configurationUrl: "https://app.example.test/api/config",
      persistentCache: false,
      memoryCache,
      fetchImplementation: () =>
        Promise.resolve(
          Response.json(browserConfig(false, "user:first")),
        ),
    });
    const second = await createThimbleConnection({
      configurationUrl: "https://app.example.test/api/config",
      persistentCache: false,
      memoryCache,
      fetchImplementation: () =>
        Promise.resolve(
          Response.json(browserConfig(false, "user:second")),
        ),
    });
    const entry = {
      key: "content-snapshot/notes/HEAD.json",
      etag: "etag",
      value: {
        revision: 1,
        snapshotHash: null,
      },
      cachedAt: Date.now(),
      checkedAt: Date.now(),
      immutable: false,
    };

    await first.cache.set(entry);

    await expect(
      second.cache.get(entry.key),
    ).resolves.toBeNull();
  });

  it("isolates reused custom persistent caches by scope", async () => {
    const persistentCache = new TestPersistentCache();
    const first = await createThimbleConnection({
      configurationUrl: "https://app.example.test/api/config",
      persistentCache,
      fetchImplementation: () =>
        Promise.resolve(
          Response.json(browserConfig(false, "user:first")),
        ),
    });
    const second = await createThimbleConnection({
      configurationUrl: "https://app.example.test/api/config",
      persistentCache,
      fetchImplementation: () =>
        Promise.resolve(
          Response.json(browserConfig(false, "user:second")),
        ),
    });
    const entry = {
      key: "content-snapshot/notes/HEAD.json",
      etag: "etag",
      value: {
        revision: 1,
        snapshotHash: null,
      },
      cachedAt: Date.now(),
      checkedAt: Date.now(),
      immutable: false,
    };

    await first.cache.set(entry);
    first.cache.clearMemory();

    await expect(
      second.cache.get(entry.key),
    ).resolves.toBeNull();
  });
});

function browserConfig(
  encrypted: boolean,
  scopeId = "user:user-1",
) {
  return {
    name: "ThimbleDB",
    provider: "local",
    readBaseUrl: "/api/objects",
    headTtlMs: 10_000,
    cachePolicy: "content",
    collectionLayouts: {
      notes: "snapshot",
    },
    layoutGeneration: "generation-1",
    csrfToken: "csrf-token",
    user: {
      id: "user-1",
      provider: "dev",
      roles: [],
      tenants: [],
      identities: [],
    },
    scope: {
      id: scopeId,
      encrypted,
      keyId: encrypted ? "scope-v1" : null,
      keyEndpoint: encrypted
        ? "/api/keys/user%3Auser-1"
        : null,
    },
  };
}

class TestPersistentCache {
  private readonly entries = new Map<string, CachedJsonObject>();

  get(key: string) {
    return Promise.resolve(
      structuredClone(this.entries.get(key) ?? null),
    );
  }

  set(entry: CachedJsonObject) {
    this.entries.set(entry.key, structuredClone(entry));
    return Promise.resolve();
  }

  delete(key: string) {
    this.entries.delete(key);
    return Promise.resolve();
  }

  clear() {
    this.entries.clear();
    return Promise.resolve();
  }

  destroy() {
    this.entries.clear();
    return Promise.resolve();
  }
}
