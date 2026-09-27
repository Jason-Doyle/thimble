import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "../src/browser/cache.js";
import { ThimbleClient } from "../src/browser/client.js";
import type {
  JsonObjectReader,
  RemoteJsonObject,
} from "../src/browser/remote-reader.js";
import type { JsonValue } from "../src/core.js";
import {
  ExperimentalAdaptiveHeadRevalidation,
  ExperimentalCompletionTimedHeadRevalidation,
} from "../src/experimental/adaptive-head-revalidation.js";
import {
  snapshotHeadKey,
  snapshotPageKey,
} from "../src/snapshot-protocol.js";
import {
  trieHeadKey,
  trieNodeKey,
  triePathFromHash,
} from "../src/trie-protocol.js";

describe("experimental adaptive HEAD revalidation", () => {
  it("backs off after unchanged HEADs and resets after a change", () => {
    const policy =
      new ExperimentalAdaptiveHeadRevalidation({
        maximumTtlMs: 10_000,
      });
    const key = trieHeadKey("notes");

    expect(policy.ttlMs(key, 1_000)).toBe(1_000);
    policy.complete(
      key,
      "not-modified",
      1_000,
      0,
      20,
    );
    expect(policy.ttlMs(key, 1_000)).toBe(2_000);
    policy.complete(
      key,
      "not-modified",
      1_000,
      2_020,
      2_040,
    );
    expect(policy.ttlMs(key, 1_000)).toBe(4_000);
    policy.complete(
      key,
      "not-modified",
      1_000,
      6_040,
      6_060,
    );
    policy.complete(
      key,
      "not-modified",
      1_000,
      14_060,
      14_080,
    );
    expect(policy.ttlMs(key, 1_000)).toBe(10_000);

    policy.complete(
      key,
      "changed",
      1_000,
      24_080,
      24_100,
    );
    expect(policy.ttlMs(key, 1_000)).toBe(1_000);
    expect(policy.diagnostics()).toMatchObject({
      notModified: 4,
      changed: 1,
      currentTtlMs: {
        [key]: 1_000,
      },
    });
  });

  it("uses response completion as the freshness timestamp", async () => {
    let now = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => now);
    try {
      const baseline = fixture("notes", "note-one");
      const baselineReader = new TimedReader(
        baseline.objects,
        () => {
          now += 1_500;
        },
      );
      const baselineClient = client(
        baselineReader,
        undefined,
      );
      await baselineClient.get("notes", baseline.id);
      now = 1_001;
      await baselineClient.get("notes", baseline.id);
      await baselineClient.get("notes", baseline.id);
      expect(baselineReader.conditionalHeadReads).toBe(2);
      baselineClient.close();

      now = 0;
      const candidate = fixture("notes", "note-two");
      const candidateReader = new TimedReader(
        candidate.objects,
        () => {
          now += 1_500;
        },
      );
      const candidateClient = client(
        candidateReader,
        new ExperimentalCompletionTimedHeadRevalidation(),
      );
      await candidateClient.get("notes", candidate.id);
      now = 1_001;
      await candidateClient.get("notes", candidate.id);
      await candidateClient.get("notes", candidate.id);
      expect(candidateReader.conditionalHeadReads).toBe(1);
      candidateClient.close();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("uses response completion for snapshot HEADs", async () => {
    let now = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => now);
    try {
      const data = snapshotFixture(
        "settings",
        "setting-one",
      );
      const reader = new TimedReader(
        data.objects,
        () => {
          now += 1_500;
        },
      );
      const clientInstance = client(
        reader,
        new ExperimentalCompletionTimedHeadRevalidation(),
        1_000,
        { settings: "snapshot" },
      );
      await clientInstance.get("settings", data.id);
      now = 1_001;
      await clientInstance.get("settings", data.id);
      await clientInstance.get("settings", data.id);
      expect(reader.conditionalHeadReads).toBe(1);
      clientInstance.close();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("preserves cached offline reads while using adaptive timing", async () => {
    const data = fixture("notes", "note-offline");
    const reader = new TimedReader(data.objects);
    const clientInstance = client(
      reader,
      new ExperimentalAdaptiveHeadRevalidation({
        maximumTtlMs: 10_000,
      }),
      0,
    );

    await clientInstance.get("notes", data.id);
    reader.offline = true;

    await expect(
      clientInstance.get("notes", data.id),
    ).resolves.toEqual(data.document);
    expect(
      clientInstance.metrics().offlineFallbacks,
    ).toBe(1);
    clientInstance.close();
  });
});

function client(
  reader: JsonObjectReader,
  headRevalidationPolicy:
    | ExperimentalAdaptiveHeadRevalidation
    | ExperimentalCompletionTimedHeadRevalidation
    | undefined,
  headTtlMs = 1_000,
  collectionLayouts?: Record<
    string,
    "snapshot" | "trie"
  >,
) {
  return new ThimbleClient({
    reader,
    cache: new TieredObjectCache(
      new MemoryObjectCache(),
      new NullPersistentObjectCache(),
      "content",
    ),
    headTtlMs,
    ...(headRevalidationPolicy
      ? { headRevalidationPolicy }
      : {}),
    ...(collectionLayouts
      ? { collectionLayouts }
      : {}),
    channelName: `adaptive-test-${crypto.randomUUID()}`,
  });
}

class TimedReader implements JsonObjectReader {
  conditionalHeadReads = 0;
  offline = false;

  constructor(
    private readonly objects: Map<
      string,
      { etag: string; value: JsonValue }
    >,
    private readonly onConditionalHeadRead?: () => void,
  ) {}

  get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<RemoteJsonObject> {
    if (this.offline) {
      return Promise.reject(new Error("offline"));
    }
    const object = this.objects.get(key);
    if (!object) {
      return Promise.resolve({ status: "missing", key });
    }
    if (ifNoneMatch === object.etag) {
      if (key.endsWith("/HEAD.json")) {
        this.conditionalHeadReads += 1;
        this.onConditionalHeadRead?.();
      }
      return Promise.resolve({
        status: "not-modified",
        key,
        etag: object.etag,
      });
    }
    return Promise.resolve({
      status: "found",
      key,
      etag: object.etag,
      value: structuredClone(object.value),
      bytes: Buffer.byteLength(
        JSON.stringify(object.value),
      ),
    });
  }
}

class NullPersistentObjectCache
implements PersistentObjectCache {
  get() {
    return Promise.resolve(null);
  }

  set() {
    return Promise.resolve();
  }

  delete() {
    return Promise.resolve();
  }

  clear() {
    return Promise.resolve();
  }

  destroy() {
    return Promise.resolve();
  }
}

function fixture(collection: string, id: string) {
  const hash = createHash("sha256").update(id).digest("hex");
  const [first, second] = triePathFromHash(hash);
  const document = {
    id,
    version: 0,
  };
  return {
    id,
    document,
    objects: new Map<
      string,
      { etag: string; value: JsonValue }
    >([
      [
        trieHeadKey(collection),
        {
          etag: "head-etag",
          value: {
            revision: 1,
            rootHash: "root-hash",
          },
        },
      ],
      [
        trieNodeKey(collection, "root-hash"),
        {
          etag: "root-etag",
          value: {
            kind: "root",
            children: { [first]: "branch-hash" },
          },
        },
      ],
      [
        trieNodeKey(collection, "branch-hash"),
        {
          etag: "branch-etag",
          value: {
            kind: "branch",
            children: { [second]: "leaf-hash" },
          },
        },
      ],
      [
        trieNodeKey(collection, "leaf-hash"),
        {
          etag: "leaf-etag",
          value: {
            kind: "leaf",
            documents: { [id]: document },
          },
        },
      ],
    ]),
  };
}

function snapshotFixture(
  collection: string,
  id: string,
) {
  const document = {
    id,
    version: 0,
  };
  return {
    id,
    document,
    objects: new Map<
      string,
      { etag: string; value: JsonValue }
    >([
      [
        snapshotHeadKey(collection),
        {
          etag: "snapshot-head-etag",
          value: {
            revision: 1,
            snapshotHash: "snapshot-hash",
          },
        },
      ],
      [
        snapshotPageKey(
          collection,
          "snapshot-hash",
        ),
        {
          etag: "snapshot-page-etag",
          value: {
            documents: { [id]: document },
          },
        },
      ],
    ]),
  };
}
