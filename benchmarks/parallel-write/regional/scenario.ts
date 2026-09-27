export {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkDocuments,
} from "../../current-regional/scenario.js";

export const PARALLEL_WRITE_DOCUMENTS = 25_000;
export const PARALLEL_WRITE_VARIANTS = [
  "sequential",
  "parallel",
] as const;
export const PARALLEL_WRITE_LAYOUTS = [
  "snapshot",
  "trie",
] as const;

export type ParallelWriteVariant =
  (typeof PARALLEL_WRITE_VARIANTS)[number];
export type ParallelWriteLayout =
  (typeof PARALLEL_WRITE_LAYOUTS)[number];
