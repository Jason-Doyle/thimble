export type ExperimentalWritePipelineOptions = {
  mode: "sequential" | "parallel";
  maximumConcurrency?: number;
};

export function experimentalWriteConcurrency(
  options: ExperimentalWritePipelineOptions,
): number {
  const value = options.maximumConcurrency ?? 3;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 8
  ) {
    throw new Error(
      "Experimental write concurrency must be 1-8",
    );
  }
  return value;
}

export async function experimentalMapBounded<T, R>(
  values: readonly T[],
  maximumConcurrency: number,
  operation: (
    value: T,
    index: number,
  ) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) {
    return [];
  }
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    {
      length: Math.min(
        maximumConcurrency,
        values.length,
      ),
    },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await operation(
          values[index]!,
          index,
        );
      }
    },
  );
  await Promise.all(workers);
  return results;
}
