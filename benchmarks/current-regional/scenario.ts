import type { JsonDocument } from "../../src/core.js";
import type {
  CollectionIndexConfiguration,
} from "../../src/secondary-index.js";

export const BENCHMARK_COLLECTION = "notes";
export const BENCHMARK_SCOPE_ID = "benchmark";
export const BENCHMARK_KEY_ID = "current-regional-v1";
export const BENCHMARK_REGIONS = [
  "eastus",
  "westus2",
  "northeurope",
  "southeastasia",
  "japaneast",
  "australiaeast",
  "brazilsouth",
] as const;
export const BENCHMARK_PROFILES = {
  small: 128,
  medium: 5_000,
  large: 25_000,
} as const;
export const BENCHMARK_INDEXES: CollectionIndexConfiguration = {
  [BENCHMARK_COLLECTION]: [
    {
      name: "by-category",
      fields: ["category"],
      mode: "equality",
      include: ["title", "lastModified"],
    },
    {
      name: "by-last-modified",
      fields: ["lastModified"],
      mode: "range",
      include: ["title", "category"],
    },
  ],
};

export type BenchmarkProfile =
  keyof typeof BENCHMARK_PROFILES;
export type BenchmarkLayout = "snapshot" | "trie";

export function benchmarkDocuments(
  count: number,
): JsonDocument[] {
  return Array.from({ length: count }, (_, index) =>
    benchmarkDocument(index, count),
  );
}

export function benchmarkDocument(
  index: number,
  count: number,
): JsonDocument {
  const rareCount = Math.max(1, Math.floor(count * 0.005));
  return {
    id: benchmarkId(index),
    title: `Note ${index}`,
    category:
      index < rareCount
        ? "rare"
        : `category-${String(index % 20).padStart(2, "0")}`,
    status: index % 7 === 0 ? "archived" : "active",
    priority: index % 5,
    body:
      `Deterministic benchmark note ${index}. ` +
      `${"representative content ".repeat(10)}${index % 97}`,
    lastModified: index,
  };
}

export function benchmarkId(index: number): string {
  return `note-${String(index).padStart(6, "0")}`;
}

export function benchmarkPointIds(
  count: number,
  samples = 64,
): string[] {
  return Array.from(
    { length: samples },
    (_, index) =>
      benchmarkId((index * 977) % count),
  );
}

export function benchmarkExpectations(count: number) {
  const rareMatches = Math.max(1, Math.floor(count * 0.005));
  return {
    rareCategory: "rare",
    rareMatches,
    rangeLower: Math.floor(count * 0.7),
    rangeUpper: Math.floor(count * 0.7) + 24,
    rangeMatches: 25,
  };
}
