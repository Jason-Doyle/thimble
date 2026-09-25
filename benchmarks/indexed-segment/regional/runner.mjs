const target = required("TARGET_URL").replace(/\/+$/, "");
const region = required("BENCHMARK_REGION");
const pointIterations = numberValue(
  process.env.POINT_ITERATIONS,
  24,
);
const queryIterations = numberValue(
  process.env.QUERY_ITERATIONS,
  8,
);
const scanIterations = numberValue(
  process.env.SCAN_ITERATIONS,
  4,
);

const pointCases = [
  "point-experimental",
  "point-snapshot",
  "point-trie",
  "point-bundle",
];
const queryGroups = {
  clusteredEquality: [
    "clustered-experimental",
    "clustered-snapshot",
  ],
  narrowRange: [
    "range-experimental",
    "range-snapshot",
  ],
  distributedEquality: [
    "distributed-experimental",
    "distributed-snapshot",
  ],
};

for (const caseName of pointCases) {
  await invoke(caseName, "note-000000");
}
for (const cases of Object.values(queryGroups)) {
  await Promise.all(cases.map((caseName) => invoke(caseName)));
}
await Promise.all([
  invoke("scan-experimental"),
  invoke("scan-snapshot"),
]);

const pointSamples = Object.fromEntries(
  pointCases.map((caseName) => [caseName, []]),
);
for (let index = 0; index < pointIterations; index += 1) {
  const id = `note-${String(
    (index * 977) % 50000,
  ).padStart(6, "0")}`;
  for (const caseName of rotate(pointCases, index)) {
    pointSamples[caseName].push(
      await invoke(caseName, id),
    );
  }
}

const queries = {};
for (const [name, cases] of Object.entries(queryGroups)) {
  const samples = Object.fromEntries(
    cases.map((caseName) => [caseName, []]),
  );
  for (let index = 0; index < queryIterations; index += 1) {
    for (const caseName of rotate(cases, index)) {
      samples[caseName].push(await invoke(caseName));
    }
  }
  queries[name] = {
    summary: summariseCases(samples),
    samples,
  };
}

const scanSamples = {
  "scan-experimental": [],
  "scan-snapshot": [],
};
for (let index = 0; index < scanIterations; index += 1) {
  for (const caseName of rotate(
    Object.keys(scanSamples),
    index,
  )) {
    scanSamples[caseName].push(await invoke(caseName));
  }
}
queries.fullScan = {
  summary: summariseCases(scanSamples),
  samples: scanSamples,
};

const result = {
  generatedAt: new Date().toISOString(),
  region,
  target,
  iterations: {
    coldPoint: pointIterations,
    query: queryIterations,
    fullScan: scanIterations,
  },
  coldPoint: summariseCases(pointSamples),
  coldPointSamples: pointSamples,
  queries,
};

console.log(`THIMBLE_RESULT=${JSON.stringify(result)}`);

async function invoke(caseName, id) {
  const url = new URL("/run", target);
  url.searchParams.set("case", caseName);
  if (id) {
    url.searchParams.set("id", id);
  }
  const started = performance.now();
  const response = await fetch(url, {
    cache: "no-store",
  });
  const clientElapsedMs = round(performance.now() - started);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `${caseName} returned ${response.status}: ${body.error}`,
    );
  }
  return {
    ...body,
    clientElapsedMs,
  };
}

function summariseCases(samples) {
  return Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [
      name,
      summarise(values),
    ]),
  );
}

function summarise(samples) {
  const worker = samples
    .map((sample) => sample.workerElapsedMs)
    .sort((left, right) => left - right);
  const client = samples
    .map((sample) => sample.clientElapsedMs)
    .sort((left, right) => left - right);
  return {
    operations: samples.length,
    workerP50Ms: percentile(worker, 0.5),
    workerP95Ms: percentile(worker, 0.95),
    workerMeanMs: mean(worker),
    clientP50Ms: percentile(client, 0.5),
    clientP95Ms: percentile(client, 0.95),
    clientMeanMs: mean(client),
    meanStorageReads: mean(
      samples.map((sample) => sample.storageReads),
    ),
    meanStorageBytes: Math.round(
      mean(samples.map((sample) => sample.storageBytes)),
    ),
    documents: samples[0]?.documents ?? 0,
    colos: [...new Set(samples.map((sample) => sample.colo))],
  };
}

function percentile(values, quantile) {
  if (values.length === 0) {
    return 0;
  }
  return values[
    Math.min(
      values.length - 1,
      Math.ceil(values.length * quantile) - 1,
    )
  ];
}

function mean(values) {
  return round(
    values.reduce((total, value) => total + value, 0) /
      values.length,
  );
}

function rotate(values, index) {
  const offset = index % values.length;
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function numberValue(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Iteration count must be 1-100");
  }
  return parsed;
}

function round(value) {
  return Number(value.toFixed(3));
}
