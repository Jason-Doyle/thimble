import {
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  WRITE_SCALING_INDEX_SETS,
  WRITE_SCALING_LAYOUTS,
  type WriteScalingIndexSet,
  type WriteScalingLayout,
  type WriteScalingProfile,
} from "./scenario.js";

type Config = {
  sourceCommit: string;
  harnessCommit: string;
  profiles: typeof BENCHMARK_PROFILES;
  indexSets: Record<string, number>;
  layouts: WriteScalingLayout[];
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
    WRITE_SCALING_INDEX_SETS,
  ).flatMap((indexSet) =>
    WRITE_SCALING_LAYOUTS.flatMap((layout) =>
      Object.keys(BENCHMARK_PROFILES).map(
        (profile) => ({
          name:
            `write-${profile}-${indexSet}-${layout}`,
          profile:
            profile as WriteScalingProfile,
          indexSet:
            indexSet as WriteScalingIndexSet,
          layout,
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
  }));
}

async function invokeWrite(
  value: {
    profile: WriteScalingProfile;
    indexSet: WriteScalingIndexSet;
    layout: WriteScalingLayout;
  },
  iteration: number,
) {
  const url = new URL("/write", target);
  url.searchParams.set("region", region);
  url.searchParams.set(
    "profile",
    value.profile,
  );
  url.searchParams.set(
    "indexes",
    value.indexSet,
  );
  url.searchParams.set(
    "layout",
    value.layout,
  );
  url.searchParams.set(
    "iteration",
    String(iteration),
  );
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-benchmark-token": token,
      },
    });
    const elapsed = round(
      performance.now() - started,
    );
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {
        error:
          `Non-JSON ${response.status}: ` +
          text.slice(0, 200),
      };
    }
    return {
      ...body,
      success: response.ok,
      status: response.status,
      clientElapsedMs: elapsed,
    };
  } catch (error) {
    return {
      ...value,
      iteration,
      success: false,
      status: 0,
      clientElapsedMs: round(
        performance.now() - started,
      ),
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
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
