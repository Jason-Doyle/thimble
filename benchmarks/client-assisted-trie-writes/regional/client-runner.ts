import {
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  CLIENT_WRITE_INDEX_SETS,
  CLIENT_WRITE_MODES,
  type ClientWriteIndexSet,
  type ClientWriteMode,
  type ClientWriteProfile,
} from "./scenario.js";
import type {
  ClientTrieWriteContext,
} from "../../../src/experimental/client-write-context.js";

type Config = {
  sourceCommit: string;
  harnessCommit: string;
  profiles: typeof BENCHMARK_PROFILES;
  indexSets: Record<string, number>;
  modes: ClientWriteMode[];
  regions: string[];
};

const target = required("TARGET_URL").replace(/\/+$/, "");
const token = required("BENCHMARK_RESULT_TOKEN");
const region = required("BENCHMARK_REGION");
const runId = required("BENCHMARK_RUN_ID");
const replicate = required("BENCHMARK_REPLICATE");
const iterations = integerValue(
  process.env.WRITE_ITERATIONS,
  4,
  1,
  10,
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
  const cases = Object.keys(
    CLIENT_WRITE_INDEX_SETS,
  ).flatMap((indexSet) =>
    CLIENT_WRITE_MODES.flatMap((mode) =>
      Object.keys(BENCHMARK_PROFILES).map(
        (profile) => ({
          name:
            `write-${profile}-${indexSet}-${mode}`,
          profile:
            profile as ClientWriteProfile,
          indexSet:
            indexSet as ClientWriteIndexSet,
          mode,
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
        await invokeWrite(value, iteration),
      );
    }
  }
  const verification = [];
  for (const profile of Object.keys(
    BENCHMARK_PROFILES,
  )) {
    for (const indexSet of Object.keys(
      CLIENT_WRITE_INDEX_SETS,
    )) {
      verification.push(
        await verifyCase(
          profile as ClientWriteProfile,
          indexSet as ClientWriteIndexSet,
        ),
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
    samples,
    verification,
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
    operations:
      cases.length * iterations,
    verified: verification.every(
      (value) => value.equivalent,
    ),
  }));
}

async function invokeWrite(
  value: {
    profile: ClientWriteProfile;
    indexSet: ClientWriteIndexSet;
    mode: ClientWriteMode;
  },
  iteration: number,
) {
  let context:
    | {
        value: ClientTrieWriteContext;
        fetchMs: number;
        responseBytes: number;
        generatedRequestBytes: number;
        workerMs: number;
      }
    | undefined;
  if (value.mode === "tree-context") {
    try {
      context = await loadContext(
        value,
        iteration,
      );
    } catch (error) {
      return failedSample(
        value,
        iteration,
        "context",
        error,
      );
    }
  }
  const url = operationUrl(
    "/write",
    value,
    iteration,
  );
  const body = context
    ? JSON.stringify(context.value)
    : undefined;
  const requestBytes = body
    ? new TextEncoder().encode(body).byteLength
    : 0;
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-benchmark-token": token,
        ...(body
          ? {
              "content-type": "application/json",
            }
          : {}),
      },
      ...(body ? { body } : {}),
    });
    const elapsed = round(
      performance.now() - started,
    );
    const text = await response.text();
    let responseBody;
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = {
        error:
          `Non-JSON ${response.status}: ` +
          text.slice(0, 200),
      };
    }
    return {
      ...responseBody,
      success: response.ok,
      status: response.status,
      clientElapsedMs: elapsed,
      combinedElapsedMs: round(
        elapsed + (context?.fetchMs ?? 0),
      ),
      requestBytes,
      contextFetchMs: context?.fetchMs ?? 0,
      contextResponseBytes:
        context?.responseBytes ?? 0,
      contextGeneratedRequestBytes:
        context?.generatedRequestBytes ?? 0,
      contextWorkerMs:
        context?.workerMs ?? 0,
    };
  } catch (error) {
    return failedSample(
      value,
      iteration,
      "write",
      error,
      {
        clientElapsedMs: round(
          performance.now() - started,
        ),
        requestBytes,
        contextFetchMs: context?.fetchMs ?? 0,
      },
    );
  }
}

async function loadContext(
  value: {
    profile: ClientWriteProfile;
    indexSet: ClientWriteIndexSet;
  },
  iteration: number,
) {
  const url = operationUrl(
    "/context",
    {
      ...value,
      mode: "tree-context",
    },
    iteration,
  );
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-benchmark-token": token,
    },
  });
  const text = await response.text();
  const fetchMs = round(
    performance.now() - started,
  );
  if (!response.ok) {
    throw new Error(
      `Context ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = JSON.parse(text) as {
    context: ClientTrieWriteContext;
    requestBytes: number;
    contextWorkerIoTimerMs: number;
  };
  return {
    value: body.context,
    fetchMs,
    responseBytes:
      new TextEncoder().encode(text).byteLength,
    generatedRequestBytes: body.requestBytes,
    workerMs: body.contextWorkerIoTimerMs,
  };
}

async function verifyCase(
  profile: ClientWriteProfile,
  indexSet: ClientWriteIndexSet,
) {
  const url = new URL("/verify", target);
  url.searchParams.set("region", region);
  url.searchParams.set("profile", profile);
  url.searchParams.set("indexes", indexSet);
  const response = await fetch(url, {
    headers: {
      "x-benchmark-token": token,
    },
  });
  const body = await response.json() as {
    equivalent?: boolean;
    error?: string;
  };
  return {
    ...body,
    success: response.ok && body.equivalent === true,
    status: response.status,
  };
}

function operationUrl(
  path: string,
  value: {
    profile: ClientWriteProfile;
    indexSet: ClientWriteIndexSet;
    mode: ClientWriteMode;
  },
  iteration: number,
) {
  const url = new URL(path, target);
  url.searchParams.set("region", region);
  url.searchParams.set(
    "profile",
    value.profile,
  );
  url.searchParams.set(
    "indexes",
    value.indexSet,
  );
  url.searchParams.set("mode", value.mode);
  url.searchParams.set(
    "iteration",
    String(iteration),
  );
  return url;
}

function failedSample(
  value: {
    profile: ClientWriteProfile;
    indexSet: ClientWriteIndexSet;
    mode: ClientWriteMode;
  },
  iteration: number,
  stage: string,
  error: unknown,
  additional: Record<string, unknown> = {},
) {
  return {
    ...value,
    iteration,
    success: false,
    status: 0,
    stage,
    ...additional,
    error:
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
  };
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
