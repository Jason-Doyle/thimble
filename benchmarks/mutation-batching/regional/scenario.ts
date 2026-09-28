import type {
  JsonDocument,
} from "../../../src/core.js";
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
  benchmarkDocuments,
};

export const MUTATION_BATCH_LAYOUTS = [
  "snapshot",
  "trie",
] as const;
export const MUTATION_BATCH_INDEX_SETS: Record<
  MutationBatchIndexSet,
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
export const MUTATION_BATCH_SIZES = [
  1,
  5,
  20,
] as const;
export const MUTATION_BATCH_STRATEGIES = [
  "individual",
  "batch",
] as const;
export const MUTATION_BATCH_REGIONAL_PROFILE =
  "large" as const;
export const MUTATION_BATCH_REGIONAL_INDEX_SET =
  "two" as const;
export const MUTATION_BATCH_DOCUMENTS =
  BENCHMARK_PROFILES[
    MUTATION_BATCH_REGIONAL_PROFILE
  ];
export const MUTATION_BATCH_ACCEPTANCE = {
  5: -50,
  20: -75,
} as const;

export type MutationBatchLayout =
  (typeof MUTATION_BATCH_LAYOUTS)[number];
export type MutationBatchIndexSet =
  | "none"
  | "one"
  | "two";
export type MutationBatchProfile =
  keyof typeof BENCHMARK_PROFILES;
export type MutationBatchSize =
  (typeof MUTATION_BATCH_SIZES)[number];
export type MutationBatchStrategy =
  (typeof MUTATION_BATCH_STRATEGIES)[number];

export function mutationDocuments(
  documentCount: number,
  batchSize: MutationBatchSize,
  iteration: number,
): JsonDocument[] {
  return Array.from(
    { length: batchSize },
    (_, offset) => {
      const index =
        (
          iteration * 2_003 +
          offset * 997
        ) % documentCount;
      const document = benchmarkDocument(
        index,
        documentCount,
      );
      return {
        ...document,
        body:
          `${document.body} mutation batch ` +
          `${batchSize} ${iteration} ${offset}`,
        lastModified:
          documentCount +
          iteration * batchSize +
          offset,
      };
    },
  );
}
