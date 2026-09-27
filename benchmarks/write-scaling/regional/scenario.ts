import type {
  CollectionIndexConfiguration,
} from "../../../src/secondary-index.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkDocuments,
} from "../../current-regional/scenario.js";

export {
  BENCHMARK_COLLECTION,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkDocuments,
};

export const WRITE_SCALING_LAYOUTS = [
  "snapshot",
  "trie",
] as const;
export type WriteScalingIndexSet =
  | "none"
  | "one"
  | "two";
export const WRITE_SCALING_INDEX_SETS: Record<
  WriteScalingIndexSet,
  CollectionIndexConfiguration
> = {
  none: {},
  one: {
    [BENCHMARK_COLLECTION]: [
      BENCHMARK_INDEXES[BENCHMARK_COLLECTION]![0]!,
    ],
  },
  two: BENCHMARK_INDEXES,
};

export type WriteScalingLayout =
  (typeof WRITE_SCALING_LAYOUTS)[number];
export type WriteScalingProfile =
  keyof typeof BENCHMARK_PROFILES;
