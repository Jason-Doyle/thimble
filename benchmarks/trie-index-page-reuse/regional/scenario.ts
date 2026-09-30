import {
  BENCHMARK_COLLECTION,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  WRITE_SCALING_INDEX_SETS,
  benchmarkDocument,
  benchmarkDocuments,
} from "../../write-scaling/regional/scenario.js";

export {
  BENCHMARK_COLLECTION,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkDocuments,
};

export const INDEX_REUSE_MODES = [
  "duplicate",
  "reuse",
] as const;
export type IndexReuseMode =
  (typeof INDEX_REUSE_MODES)[number];
export type IndexReuseProfile =
  keyof typeof BENCHMARK_PROFILES;
export type IndexReuseIndexSet =
  | "one"
  | "two";
export const INDEX_REUSE_INDEX_SETS = {
  one: WRITE_SCALING_INDEX_SETS.one,
  two: WRITE_SCALING_INDEX_SETS.two,
} as const;
