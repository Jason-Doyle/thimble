import {
  BENCHMARK_REGIONS,
  MUTATION_BATCH_DOCUMENTS,
  MUTATION_BATCH_LAYOUTS,
  MUTATION_BATCH_SIZES,
  MUTATION_BATCH_STRATEGIES,
  mutationDocuments,
  type MutationBatchLayout,
  type MutationBatchSize,
  type MutationBatchStrategy,
} from "./scenario.js";

type Config = {
  sourceCommit: string;
  harnessCommit: string;
  profile: "large";
  documents: number;
  indexSet: "two";
  indexCount: number;
  batchSizes: MutationBatchSize[];
  strategies: MutationBatchStrategy[];
  layouts: MutationBatchLayout[];
  regions: string[];
};

type OperationMetric = {
  count: number;
  bytes: number;
  durationMs: number;
};

type StoreMetrics = {
  reads: OperationMetric;
  writes: OperationMetric;
  preconditionFailures: number;
  byKind: Record<
    string,
    {
      reads: OperationMetric;
      writes: OperationMetric;
    }
  >;
};

type WriteResponse = {
  success: boolean;
  status: number;
  workerIoTimerMs?: number;
  storage?: StoreMetrics;
  diagnostics?: Record<string, number>;
  error?: string;
};

const target = required("TARGET_URL").replace(/\/+$/, "");
const token = required("BENCHMARK_RESULT_TOKEN");
const region = required("BENCHMARK_REGION");
const runId = required("BENCHMARK_RUN_ID");
const replicate = required("BENCHMARK_REPLICATE");
const iterations = integerValue(
  process.env.MUTATION_ITERATIONS,
  3,
  1,
  6,
);

async function main() {
  const response = await fetch(
    `${target}/benchmark-config.json`,
    {
      cache: "no-store",
      headers: {
        "x-benchmark-token": token,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Config failed with ${response.status}`,
    );
  }
  const config = (await response.json()) as Config;
  const colo =
    response.headers.get("x-benchmark-colo") ??
      "unknown";
  const cases = MUTATION_BATCH_LAYOUTS.flatMap(
    (layout) =>
      MUTATION_BATCH_SIZES.flatMap((batchSize) =>
        MUTATION_BATCH_STRATEGIES.map(
          (strategy) => ({
            name:
              `mutation-${layout}-batch-${batchSize}-${strategy}`,
            layout,
            batchSize,
            strategy,
          }),
        ),
      ),
  );
  const samples = Object.fromEntries(
    cases.map((value) => [value.name, []]),
  ) as Record<string, unknown[]>;

  for (
    let iteration = 0;
    iteration < iterations;
    iteration += 1
  ) {
    for (const value of rotate(cases, iteration)) {
      samples[value.name]!.push(
        await invokeGroup(value, iteration),
      );
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    runId,
    replicate,
    region,
    colo,
    runtime: `Node ${process.version}`,
    iterations,
    profile: config.profile,
    documents: config.documents,
    indexSet: config.indexSet,
    indexCount: config.indexCount,
    samples,
  };
  const resultUrl = new URL(
    "/regional-result",
    target,
  );
  resultUrl.searchParams.set("run", runId);
  resultUrl.searchParams.set("region", region);
  const stored = await fetch(resultUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-benchmark-token": token,
    },
    body: JSON.stringify(result),
  });
  if (!stored.ok) {
    throw new Error(
      `Result upload failed with ${stored.status}`,
    );
  }
  console.log(JSON.stringify({
    stored: true,
    region,
    replicate,
    colo,
    logicalOperations:
      cases.length * iterations,
  }));
}

async function invokeGroup(
  value: {
    layout: MutationBatchLayout;
    batchSize: MutationBatchSize;
    strategy: MutationBatchStrategy;
  },
  iteration: number,
) {
  const documents = mutationDocuments(
    MUTATION_BATCH_DOCUMENTS,
    value.batchSize,
    iteration,
  );
  const expectedRevision =
    1 +
    (iteration + 1) *
      (value.strategy === "batch"
        ? 1
        : value.batchSize);
  const started = performance.now();
  const responses: WriteResponse[] = [];
  if (value.strategy === "batch") {
    responses.push(
      await writeRequest(
        value,
        iteration,
        documents,
      ),
    );
  } else {
    for (const document of documents) {
      responses.push(
        await writeRequest(
          value,
          iteration,
          document,
        ),
      );
    }
  }
  const clientElapsedMs = round(
    performance.now() - started,
  );
  const aggregated = aggregateResponses(responses);
  const verificationStarted = performance.now();
  const verification = await verify(
    value,
    iteration,
    expectedRevision,
    documents,
  );
  const verificationElapsedMs = round(
    performance.now() - verificationStarted,
  );
  return {
    ...value,
    iteration,
    documents: documents.length,
    requests: responses.length,
    clientElapsedMs,
    workerIoTimerMs:
      aggregated.workerIoTimerMs,
    storage: aggregated.storage,
    diagnostics: aggregated.diagnostics,
    writeSuccess: aggregated.success,
    writeErrors: aggregated.errors,
    verificationElapsedMs,
    verificationPassed:
      verification.verificationPassed,
    expectedRevision,
    revision: verification.revision,
    verifiedDocuments:
      verification.verifiedDocuments,
    verificationError: verification.error,
    success:
      aggregated.success &&
      verification.verificationPassed,
  };
}

async function writeRequest(
  value: {
    layout: MutationBatchLayout;
    batchSize: MutationBatchSize;
    strategy: MutationBatchStrategy;
  },
  iteration: number,
  body: unknown,
): Promise<WriteResponse> {
  const url = operationUrl(
    "/write",
    value,
    iteration,
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-benchmark-token": token,
      },
      body: JSON.stringify(body),
    });
    const parsed = await responseBody(response);
    return {
      ...(parsed as Omit<
        WriteResponse,
        "success" | "status"
      >),
      success: response.ok,
      status: response.status,
      ...(!response.ok
        ? {
            error:
              errorMessage(parsed) ??
              `HTTP ${response.status}`,
          }
        : {}),
    };
  } catch (error) {
    return {
      success: false,
      status: 0,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
}

async function verify(
  value: {
    layout: MutationBatchLayout;
    batchSize: MutationBatchSize;
    strategy: MutationBatchStrategy;
  },
  iteration: number,
  expectedRevision: number,
  documents: unknown[],
) {
  const url = operationUrl(
    "/verify",
    value,
    iteration,
  );
  url.searchParams.set(
    "expectedRevision",
    String(expectedRevision),
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-benchmark-token": token,
      },
      body: JSON.stringify(documents),
    });
    const parsed = await responseBody(response);
    return {
      verificationPassed:
        response.ok &&
        parsed.verificationPassed === true,
      revision:
        typeof parsed.revision === "number"
          ? parsed.revision
          : null,
      verifiedDocuments:
        typeof parsed.verifiedDocuments ===
        "number"
          ? parsed.verifiedDocuments
          : 0,
      ...(!response.ok ||
      parsed.verificationPassed !== true
        ? {
            error:
              errorMessage(parsed) ??
              `Verification HTTP ${response.status}`,
          }
        : {}),
    };
  } catch (error) {
    return {
      verificationPassed: false,
      revision: null,
      verifiedDocuments: 0,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
}

function aggregateResponses(
  responses: WriteResponse[],
) {
  const storage = createStoreMetrics();
  const errors: string[] = [];
  let workerIoTimerMs = 0;
  let casRetries = 0;
  for (const response of responses) {
    workerIoTimerMs +=
      response.workerIoTimerMs ?? 0;
    casRetries +=
      response.diagnostics?.casRetries ?? 0;
    if (response.storage) {
      addStoreMetrics(storage, response.storage);
    }
    if (!response.success) {
      errors.push(
        response.error ??
          `HTTP ${response.status}`,
      );
    }
  }
  return {
    success: responses.every(
      (response) => response.success,
    ),
    errors,
    workerIoTimerMs: round(workerIoTimerMs),
    storage,
    diagnostics: {
      casRetries,
    },
  };
}

function addStoreMetrics(
  target: StoreMetrics,
  source: StoreMetrics,
) {
  addMetric(target.reads, source.reads);
  addMetric(target.writes, source.writes);
  target.preconditionFailures +=
    source.preconditionFailures;
  for (const [kind, metrics] of Object.entries(
    source.byKind,
  )) {
    target.byKind[kind] ??= {
      reads: metric(),
      writes: metric(),
    };
    addMetric(
      target.byKind[kind]!.reads,
      metrics.reads,
    );
    addMetric(
      target.byKind[kind]!.writes,
      metrics.writes,
    );
  }
}

function addMetric(
  target: OperationMetric,
  source: OperationMetric,
) {
  target.count += source.count;
  target.bytes += source.bytes;
  target.durationMs = round(
    target.durationMs + source.durationMs,
  );
}

function createStoreMetrics(): StoreMetrics {
  return {
    reads: metric(),
    writes: metric(),
    preconditionFailures: 0,
    byKind: {},
  };
}

function metric(): OperationMetric {
  return {
    count: 0,
    bytes: 0,
    durationMs: 0,
  };
}

function operationUrl(
  pathname: string,
  value: {
    layout: MutationBatchLayout;
    batchSize: MutationBatchSize;
    strategy: MutationBatchStrategy;
  },
  iteration: number,
) {
  const url = new URL(pathname, target);
  url.searchParams.set("region", region);
  url.searchParams.set(
    "strategy",
    value.strategy,
  );
  url.searchParams.set(
    "layout",
    value.layout,
  );
  url.searchParams.set(
    "batch",
    String(value.batchSize),
  );
  url.searchParams.set(
    "iteration",
    String(iteration),
  );
  return url;
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { error: "Response JSON was not an object" };
  } catch {
    return {
      error:
        `Non-JSON ${response.status}: ` +
        text.slice(0, 200),
    };
  }
}

function errorMessage(
  value: Record<string, unknown>,
) {
  return typeof value.error === "string"
    ? value.error
    : null;
}

function rotate<T>(
  values: readonly T[],
  index: number,
) {
  const offset = index % values.length;
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
}

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `Iterations must be ${minimum}-${maximum}`,
    );
  }
  return parsed;
}

function round(value: number) {
  return Number(value.toFixed(3));
}

void BENCHMARK_REGIONS;
await main();
