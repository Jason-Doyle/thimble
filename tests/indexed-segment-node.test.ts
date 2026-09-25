import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  buildIndexedSegment,
  IndexedSegmentReader,
} from "../src/experimental/indexed-segment.js";
import {
  FileIndexedSegmentSource,
} from "../src/experimental/indexed-segment-node.js";

describe("experimental indexed segment file source", () => {
  it("performs bounded file reads", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-segment-"),
    );
    const filePath = path.join(directory, "products.tis");
    try {
      const documents = Array.from(
        { length: 200 },
        (_, index) => ({
          id: `product-${index.toString().padStart(4, "0")}`,
          category: index < 20 ? "rare" : "common",
          score: index,
          body: "x".repeat(120),
        }),
      );
      const bytes = await buildIndexedSegment(documents, {
        targetBlockBytes: 2_048,
        fields: [
          { field: "category", mode: "equality" },
          { field: "score", mode: "range" },
        ],
      });
      await writeFile(filePath, bytes);
      const source = await FileIndexedSegmentSource.open(filePath);
      try {
        const reader = await IndexedSegmentReader.open(source, {
          cacheBlocks: false,
        });
        source.resetMetrics();
        expect(await reader.get("product-0175")).toEqual(
          documents[175],
        );
        expect(source.reads).toBe(2);
        expect(source.bytesRead).toBeLessThan(bytes.byteLength);

        source.resetMetrics();
        const result = await reader.query({
          field: "score",
          operator: "between",
          lower: 170,
          upper: 179,
        });
        expect(result.documents).toEqual(
          documents.slice(170, 180),
        );
        expect(result.blocksSkipped).toBeGreaterThan(0);
        expect(source.bytesRead).toBeLessThan(bytes.byteLength);
      } finally {
        await source.close();
      }
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});
