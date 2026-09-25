import {
  describe,
  expect,
  it,
} from "vitest";
import type { JsonDocument } from "../src/core.js";
import { importAesGcmKey } from "../src/envelope.js";
import {
  buildIndexedSegment,
  BlobIndexedSegmentSource,
  HttpIndexedSegmentSource,
  IndexedSegmentReader,
  MemoryIndexedSegmentSource,
} from "../src/experimental/indexed-segment.js";

describe("experimental indexed segment", () => {
  it("builds deterministically and resolves IDs with bounded range reads", async () => {
    const documents = products(80);
    const first = await buildIndexedSegment(documents, {
      targetBlockBytes: 1_024,
      compression: "none",
      fields: [
        { field: "category", mode: "equality" },
        { field: "priceCents", mode: "range" },
      ],
    });
    const second = await buildIndexedSegment(
      [...documents].reverse(),
      {
        targetBlockBytes: 1_024,
        compression: "none",
        fields: [
          { field: "priceCents", mode: "range" },
          { field: "category", mode: "equality" },
        ],
      },
    );
    expect(second).toEqual(first);

    const source = new MemoryIndexedSegmentSource(first);
    const reader = await IndexedSegmentReader.open(source);
    const afterOpen = {
      reads: source.reads,
      bytes: source.bytesRead,
    };
    expect(afterOpen.reads).toBe(2);
    expect(reader.diagnostics().blocks).toBeGreaterThan(1);

    expect(await reader.get("product-0042")).toEqual(
      documents[42],
    );
    expect(source.reads).toBe(afterOpen.reads + 2);
    expect(source.bytesRead).toBeLessThan(first.byteLength);

    expect(await reader.get("product-0042")).toEqual(
      documents[42],
    );
    expect(source.reads).toBe(afterOpen.reads + 2);

    const beforeMissing = source.reads;
    expect(await reader.get("missing")).toBeNull();
    expect(source.reads).toBeLessThanOrEqual(beforeMissing + 1);
  });

  it("uses locale-independent ordering and snapshots mutable input", async () => {
    const documents: JsonDocument[] = [
      {
        id: "é",
        label: "old",
      },
      {
        id: "e\u0301",
        label: "decomposed",
      },
    ];
    const build = buildIndexedSegment(documents, {
      targetBlockBytes: 1_024,
      fields: [
        { field: "label", mode: "equality" },
      ],
    });
    documents[0]!.label = "new";
    const first = await build;
    const second = await buildIndexedSegment(
      [...documents]
        .map((document) =>
          document.id === "é"
            ? { ...document, label: "old" }
            : document,
        )
        .reverse(),
      {
        targetBlockBytes: 1_024,
        fields: [
          { field: "label", mode: "equality" },
        ],
      },
    );
    expect(first).toEqual(second);
    const reader = await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(first),
    );
    expect(await reader.get("é")).toMatchObject({
      label: "old",
    });
    expect(
      (
        await reader.query({
          field: "label",
          operator: "eq",
          value: "old",
        })
      ).documents,
    ).toHaveLength(1);
  });

  it("uses Bloom filters and zone maps without changing JSON results", async () => {
    const documents = products(180);
    const segment = await buildIndexedSegment(documents, {
      targetBlockBytes: 1_024,
      fields: [
        { field: "category", mode: "equality" },
        { field: "priceCents", mode: "range" },
      ],
    });
    const source = new MemoryIndexedSegmentSource(segment);
    const reader = await IndexedSegmentReader.open(source, {
      cacheBlocks: false,
    });

    source.resetMetrics();
    const equality = await reader.query({
      field: "category",
      operator: "eq",
      value: "archive",
    });
    expect(equality.plan).toBe("block-filter");
    expect(equality.documents).toEqual(
      documents.filter(
        (document) => document.category === "archive",
      ),
    );
    expect(equality.blocksSkipped).toBeGreaterThan(0);
    expect(equality.blocksRead).toBeLessThan(
      equality.blocksConsidered,
    );

    source.resetMetrics();
    const range = await reader.query({
      field: "priceCents",
      operator: "between",
      lower: 10_080,
      upper: 10_089,
    });
    expect(range.plan).toBe("block-filter");
    expect(range.documents.map((document) => document.id)).toEqual(
      documents.slice(80, 90).map((document) => document.id),
    );
    expect(range.blocksSkipped).toBeGreaterThan(0);

    source.resetMetrics();
    const unindexed = await reader.query({
      field: "name",
      operator: "eq",
      value: "Product 17",
    });
    expect(unindexed.plan).toBe("scan");
    expect(unindexed.documents).toEqual([documents[17]]);
    expect(unindexed.blocksRead).toBe(
      unindexed.blocksConsidered,
    );
  });

  it("round-trips compressed blocks and preserves special IDs", async () => {
    const documents: JsonDocument[] = [
      {
        id: "__proto__",
        category: "special",
        body: "x".repeat(2_000),
        nested: {
          enabled: true,
          values: [1, "two", null],
        },
      },
      {
        id: "toString",
        category: "special",
        body: "x".repeat(2_000),
      },
    ];
    const segment = await buildIndexedSegment(documents, {
      targetBlockBytes: 1_024,
      recordEncoding: "binary",
      fields: [
        { field: "category", mode: "equality" },
      ],
    });
    const reader = await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(segment),
    );
    expect(reader.diagnostics().dataBytes).toBeLessThan(
      reader.diagnostics().decodedDataBytes,
    );
    expect(await reader.get("__proto__")).toEqual(documents[0]);
    expect(await reader.get("toString")).toEqual(documents[1]);
    expect(await reader.scan()).toEqual(documents);
  });

  it("preserves leading BOM code points in binary strings and bounds", async () => {
    const document: JsonDocument = {
      id: "\uFEFFid",
      label: "\uFEFFvalue",
    };
    const segment = await buildIndexedSegment([document], {
      recordEncoding: "binary",
      fields: [
        { field: "label", mode: "range" },
      ],
    });
    const reader = await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(segment),
    );
    expect(await reader.get(document.id)).toEqual(document);
    expect(
      (
        await reader.query({
          field: "label",
          operator: "between",
          lower: document.label as string,
          upper: document.label as string,
        })
      ).documents,
    ).toEqual([document]);
  });

  it("rejects invalid definitions and corrupt footer or data bytes", async () => {
    await expect(
      buildIndexedSegment([
        { id: "duplicate", value: 1 },
        { id: "duplicate", value: 2 },
      ]),
    ).rejects.toThrow("duplicate");
    await expect(
      buildIndexedSegment([{ id: "one", value: 1 }], {
        fields: [
          { field: "__proto__", mode: "equality" },
        ],
      }),
    ).rejects.toThrow("field definition");
    await expect(
      buildIndexedSegment([
        {
          id: "not-finite",
          value: Number.NaN,
        } as JsonDocument,
      ]),
    ).rejects.toThrow("finite");
    const inherited = Object.create({
      id: "inherited",
    }) as JsonDocument;
    inherited.value = 1;
    await expect(
      buildIndexedSegment([inherited]),
    ).rejects.toThrow("own id");

    const segment = await buildIndexedSegment(products(20), {
      targetBlockBytes: 1_024,
      compression: "none",
    });
    const footerCorrupt = segment.slice();
    footerCorrupt[footerCorrupt.byteLength - 41]! ^= 1;
    await expect(
      IndexedSegmentReader.open(
        new MemoryIndexedSegmentSource(footerCorrupt),
      ),
    ).rejects.toThrow("footer hash mismatch");

    const dataCorrupt = segment.slice();
    dataCorrupt[0]! ^= 1;
    const reader = await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(dataCorrupt),
    );
    await expect(reader.get("product-0000")).rejects.toThrow(
      "block hash mismatch",
    );
  });

  it("handles empty segments and validates query bounds", async () => {
    const segment = await buildIndexedSegment([], {
      fields: [
        { field: "score", mode: "range" },
      ],
    });
    const reader = await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(segment),
    );
    expect(await reader.get("missing")).toBeNull();
    expect(await reader.scan()).toEqual([]);
    await expect(
      reader.query({
        field: "score",
        operator: "between",
        lower: 10,
        upper: 1,
      }),
    ).rejects.toThrow("range predicate");
  });

  it("encrypts independent blocks and the indexed footer", async () => {
    const rawKey = Uint8Array.from(
      { length: 32 },
      (_, index) => index + 1,
    );
    const key = await importAesGcmKey(
      rawKey,
      ["encrypt", "decrypt"],
    );
    const fingerprintKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );
    const documents = products(60);
    const segment = await buildIndexedSegment(documents, {
      targetBlockBytes: 1_024,
      recordEncoding: "binary",
      fields: [
        { field: "category", mode: "equality" },
      ],
      security: {
        key,
        keyId: "test-key",
        fingerprintKey,
        context: "scope:test/products",
      },
    });
    expect(new TextDecoder().decode(segment)).not.toContain(
      "product-0042",
    );

    await expect(
      IndexedSegmentReader.open(
        new MemoryIndexedSegmentSource(segment),
      ),
    ).rejects.toThrow("resolver");
    await expect(
      IndexedSegmentReader.open(
        new MemoryIndexedSegmentSource(segment),
        {
          security: {
            resolveKey: () => key,
            fingerprintKey,
            context: "scope:wrong/products",
          },
        },
      ),
    ).rejects.toThrow();

    const wrongFingerprintKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(
        { length: 32 },
        (_, index) => index + 2,
      ),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );
    await expect(
      IndexedSegmentReader.open(
        new MemoryIndexedSegmentSource(segment),
        {
          security: {
            resolveKey: () => key,
            fingerprintKey: wrongFingerprintKey,
            context: "scope:test/products",
          },
        },
      ),
    ).rejects.toThrow("fingerprint key");

    const reader = await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(segment),
      {
        security: {
          resolveKey: (keyId) =>
            keyId === "test-key" ? key : null,
          fingerprintKey,
          context: "scope:test/products",
        },
      },
    );
    expect(await reader.get("product-0042")).toEqual(
      documents[42],
    );
    const found = await reader.query({
      field: "category",
      operator: "eq",
      value: "archive",
    });
    expect(found.documents).toEqual(
      documents.filter(
        (document) => document.category === "archive",
      ),
    );
  });

  it("reads the footer and blocks through exact HTTP ranges", async () => {
    const documents = products(40);
    const segment = await buildIndexedSegment(documents, {
      targetBlockBytes: 1_024,
    });
    const ranges: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const range = new Headers(init?.headers).get("range");
      ranges.push(range ?? "");
      const suffix = /^bytes=-(\d+)$/.exec(range ?? "");
      const explicit = /^bytes=(\d+)-(\d+)$/.exec(
        range ?? "",
      );
      if (!suffix && !explicit) {
        return new Response(null, { status: 400 });
      }
      const start = suffix
        ? Math.max(
            0,
            segment.byteLength - Number(suffix[1]),
          )
        : Number(explicit![1]);
      const end = suffix
        ? segment.byteLength - 1
        : Number(explicit![2]);
      return new Response(segment.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-range":
            `bytes ${start}-${end}/${segment.byteLength}`,
        },
      });
    };
    const source = await HttpIndexedSegmentSource.open(
      "https://database.example.com/products.tis",
      {
        fetch: fetcher,
        directoryPrefetchBytes: 40,
      },
    );
    const reader = await IndexedSegmentReader.open(source, {
      cacheBlocks: false,
    });
    expect(await reader.get("product-0020")).toEqual(
      documents[20],
    );
    expect(ranges).toHaveLength(4);
    expect(source.reads).toBe(4);
    expect(source.bytesRead).toBeLessThan(segment.byteLength);

    ranges.length = 0;
    const prefetched = await HttpIndexedSegmentSource.open(
      "https://database.example.com/products.tis",
      { fetch: fetcher },
    );
    const prefetchedReader =
      await IndexedSegmentReader.open(prefetched);
    expect(await prefetchedReader.get("product-0020")).toEqual(
      documents[20],
    );
    expect(ranges).toHaveLength(1);
    expect(prefetched.reads).toBe(1);

    await expect(
      HttpIndexedSegmentSource.open(
        "https://database.example.com/oversized.tis",
        {
          directoryPrefetchBytes: 40,
          fetch: async () =>
            new Response(new Uint8Array(41), {
              status: 206,
              headers: {
                "content-range": "bytes 0-39/40",
              },
            }),
        },
      ),
    ).rejects.toThrow("larger than requested");

    const blobBytes = new Uint8Array(
      new ArrayBuffer(segment.byteLength),
    );
    blobBytes.set(segment);
    const blobReader = await IndexedSegmentReader.open(
      new BlobIndexedSegmentSource(
        new Blob([blobBytes.buffer]),
      ),
    );
    expect(await blobReader.get("product-0001")).toEqual(
      documents[1],
    );
  });
});

function products(count: number): JsonDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `product-${index.toString().padStart(4, "0")}`,
    name: `Product ${index}`,
    category:
      index < Math.floor(count / 3)
        ? "archive"
        : index < Math.floor((count * 2) / 3)
          ? "home"
          : "office",
    priceCents: 10_000 + index,
    active: index % 3 !== 0,
    body: `Deterministic body ${index} ${"x".repeat(80)}`,
  }));
}
