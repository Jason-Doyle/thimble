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

export const CLIENT_WRITE_MODES = [
  "baseline",
  "tree-context",
] as const;
export type ClientWriteMode =
  (typeof CLIENT_WRITE_MODES)[number];
export type ClientWriteIndexSet =
  | "none"
  | "one"
  | "two";
export type ClientWriteProfile =
  keyof typeof BENCHMARK_PROFILES;

export const CLIENT_WRITE_INDEX_SETS: Record<
  ClientWriteIndexSet,
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
