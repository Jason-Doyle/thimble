export const BENCHMARK_COLLECTION = "notes";
export const BENCHMARK_DOCUMENT_ID = "note-000001";
export const BENCHMARK_SCOPE_ID = "benchmark";
export const BENCHMARK_KEY_ID =
  "adaptive-head-revalidation-v1";
export const BENCHMARK_REGIONS = [
  "eastus",
  "westus2",
  "northeurope",
  "southeastasia",
  "japaneast",
  "australiaeast",
  "brazilsouth",
] as const;
export const BENCHMARK_LAYOUTS = [
  "snapshot",
  "trie",
] as const;
export const BENCHMARK_POLICIES = [
  "current-1s",
  "completion-1s",
  "fixed-10s",
  "adaptive-1-to-10s",
] as const;

export type BenchmarkRegion =
  (typeof BENCHMARK_REGIONS)[number];
export type BenchmarkLayout =
  (typeof BENCHMARK_LAYOUTS)[number];
export type BenchmarkPolicy =
  (typeof BENCHMARK_POLICIES)[number];

export function benchmarkDocument(version: number) {
  return {
    id: BENCHMARK_DOCUMENT_ID,
    title: `Adaptive revalidation version ${version}`,
    version,
    body:
      "Deterministic browser freshness benchmark document.",
    lastModified: version,
  };
}
