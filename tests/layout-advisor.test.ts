import { describe, expect, it } from "vitest";
import { recommendCollectionLayout } from "../src/layout-advisor.js";

describe("layout advisor", () => {
  it("recommends snapshots for small scan-heavy collections", () => {
    expect(
      recommendCollectionLayout({
        documentCount: 100,
        averageDocumentBytes: 800,
        pointReadRatio: 0.3,
        scanRatio: 0.6,
        writesPerMinute: 0.2,
        concurrentWriters: 1,
      }),
    ).toMatchObject({
      layout: "snapshot",
      confidence: "high",
    });
  });

  it("recommends tries for large point-read and concurrent workloads", () => {
    expect(
      recommendCollectionLayout({
        documentCount: 2_000,
        averageDocumentBytes: 1_000,
        pointReadRatio: 0.85,
        scanRatio: 0.1,
        writesPerMinute: 10,
        concurrentWriters: 4,
      }),
    ).toMatchObject({
      layout: "trie",
      confidence: "high",
    });
  });

  it("keeps ambiguous evidence low confidence", () => {
    expect(
      recommendCollectionLayout({
        documentCount: 300,
        averageDocumentBytes: 1_000,
        pointReadRatio: 0.5,
        scanRatio: 0.3,
        writesPerMinute: 2,
        concurrentWriters: 1,
      }).confidence,
    ).toBe("low");
  });
});
