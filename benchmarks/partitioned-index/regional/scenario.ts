import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkDocuments,
  benchmarkExpectations,
  benchmarkId,
  benchmarkPointIds,
} from "../../current-regional/scenario.js";
import type {
  ExperimentalPartitionedIndexConfiguration,
} from "../../../src/experimental/partitioned-secondary-index.js";

export {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocument,
  benchmarkDocuments,
  benchmarkExpectations,
  benchmarkId,
  benchmarkPointIds,
};

export const PARTITIONED_INDEX_DOCUMENTS = 25_000;
export const PARTITIONED_INDEX_SHARDS = 8;
export const PARTITIONED_INDEX_VARIANTS = [
  "baseline",
  "partitioned",
] as const;

export type PartitionedIndexVariant =
  (typeof PARTITIONED_INDEX_VARIANTS)[number];
export type PartitionedIndexLayout = "snapshot" | "trie";

export const PARTITIONED_INDEX_CONFIGURATION:
  ExperimentalPartitionedIndexConfiguration = {
    [BENCHMARK_COLLECTION]: Object.fromEntries(
      BENCHMARK_INDEXES[BENCHMARK_COLLECTION]!.map(
        (definition) => [
          definition.name,
          PARTITIONED_INDEX_SHARDS,
        ],
      ),
    ),
  };
