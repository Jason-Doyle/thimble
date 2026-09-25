import {
  describe,
  expect,
  it,
} from "vitest";
import type { JsonDocument } from "../src/core.js";
import {
  ExperimentalIndexedSegmentEngine,
} from "../src/experimental/indexed-segment-engine.js";

describe("experimental indexed segment engine", () => {
  it("implements the database engine contract through rebuilt segments", async () => {
    const engine = new ExperimentalIndexedSegmentEngine({
      targetBlockBytes: 1_024,
      collectionFields: {
        products: [
          { field: "category", mode: "equality" },
          { field: "priceCents", mode: "range" },
        ],
      },
    });
    const documents = products(40);
    await engine.putMany("products", documents);

    expect(await engine.get("products", documents[12]!.id)).toEqual(
      documents[12],
    );
    expect(await engine.scan("products")).toEqual(documents);

    const category = await engine.query("products", {
      field: "category",
      operator: "eq",
      value: "archive",
    });
    expect(category.documents).toEqual(
      documents.filter(
        (document) => document.category === "archive",
      ),
    );

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        engine.put("products", `concurrent-${index}`, {
          id: `concurrent-${index}`,
          category: "concurrent",
          priceCents: index,
        }),
      ),
    );
    expect(await engine.scan("products")).toHaveLength(50);
    expect(engine.diagnostics().rebuilds).toBe(11);
  });

  it("supports binary records and validates identifiers", async () => {
    const engine = new ExperimentalIndexedSegmentEngine({
      targetBlockBytes: 1_024,
      recordEncoding: "binary",
    });
    const document: JsonDocument = {
      id: "__proto__",
      nested: {
        values: [1, "two", true, null],
      },
    };
    await engine.put("items", document.id, document);
    expect(await engine.get("items", document.id)).toEqual(
      document,
    );
    await expect(
      engine.put("items", "other", document),
    ).rejects.toThrow("does not match");
    await expect(engine.scan("../items")).rejects.toThrow(
      "must be",
    );

    const configured = new ExperimentalIndexedSegmentEngine({
      collectionFields: {
        products: [],
      },
    });
    await configured.put("constructor", "one", {
      id: "one",
      value: 1,
    });
    expect(await configured.get("constructor", "one")).toEqual({
      id: "one",
      value: 1,
    });
  });
});

function products(count: number): JsonDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `product-${index.toString().padStart(4, "0")}`,
    category: index < 10 ? "archive" : "active",
    priceCents: 1_000 + index,
    name: `Product ${index}`,
  }));
}
