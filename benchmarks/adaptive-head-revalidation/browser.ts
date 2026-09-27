import {
  MemoryObjectCache,
  TieredObjectCache,
  type PersistentObjectCache,
} from "../../src/browser/cache.js";
import {
  type HeadRevalidationPolicy,
  ThimbleClient,
} from "../../src/browser/client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  ScopedJsonObjectReader,
} from "../../src/browser/remote-reader.js";
import {
  base64ToBytes,
  importAesGcmKey,
} from "../../src/envelope.js";
import {
  ExperimentalAdaptiveHeadRevalidation,
  ExperimentalCompletionTimedHeadRevalidation,
} from "../../src/experimental/adaptive-head-revalidation.js";
import type { CollectionLayout } from "../../src/snapshot-protocol.js";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_DOCUMENT_ID,
  BENCHMARK_LAYOUTS,
  BENCHMARK_POLICIES,
  BENCHMARK_SCOPE_ID,
  type BenchmarkLayout,
  type BenchmarkPolicy,
} from "./scenario.js";

type BrowserBenchmarkOptions = {
  target: string;
  token: string;
  runId: string;
  region: string;
  replicate: string;
};

type BenchmarkConfig = {
  sourceCommit: string;
  harnessCommit: string;
  keyBase64: string;
  keyId: string;
  decodedObjectLimit: number;
  stableDurationMs: number;
  readIntervalMs: number;
  mutationTimeoutMs: number;
};

type BenchmarkDocument = {
  id: string;
  version: number;
};

type ScenarioDefinition = {
  policy: BenchmarkPolicy;
  layout: BenchmarkLayout;
};

type ClientRuntime = {
  client: ThimbleClient;
  cache: TieredObjectCache;
  transport: TrackingFetch;
  adaptive:
    | ExperimentalAdaptiveHeadRevalidation
    | undefined;
};

declare global {
  interface Window {
    runAdaptiveHeadBenchmark(
      options: BrowserBenchmarkOptions,
    ): Promise<unknown>;
  }
}

window.runAdaptiveHeadBenchmark =
  runAdaptiveHeadBenchmark;

async function runAdaptiveHeadBenchmark(
  options: BrowserBenchmarkOptions,
) {
  const target = options.target.replace(/\/+$/, "");
  const security = await securityChecks(target);
  const configResponse = await fetch(
    `${target}/benchmark-config.json`,
    {
      cache: "no-store",
      headers: {
        "x-benchmark-token": options.token,
      },
    },
  );
  if (!configResponse.ok) {
    throw new Error(
      `Benchmark configuration failed with ${configResponse.status}`,
    );
  }
  const colo =
    configResponse.headers.get("x-benchmark-colo") ??
      "unknown";
  const config =
    (await configResponse.json()) as BenchmarkConfig;
  const rawKey = base64ToBytes(config.keyBase64);
  const key = await importAesGcmKey(
    rawKey,
    ["decrypt"],
  );
  rawKey.fill(0);

  const definitions = rotate(
    BENCHMARK_LAYOUTS.flatMap((layout) =>
      BENCHMARK_POLICIES.map((policy) => ({
        layout,
        policy,
      })),
    ),
    hashOffset(
      `${options.runId}:${options.region}:${options.replicate}`,
      BENCHMARK_LAYOUTS.length *
        BENCHMARK_POLICIES.length,
    ),
  );
  const scenarios = [];
  for (const definition of definitions) {
    scenarios.push(
      await runScenario(
        options,
        config,
        key,
        definition,
      ),
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    harnessCommit: config.harnessCommit,
    runId: options.runId,
    replicate: options.replicate,
    region: options.region,
    colo,
    userAgent: navigator.userAgent,
    security,
    scenarios,
  };
}

async function runScenario(
  options: BrowserBenchmarkOptions,
  config: BenchmarkConfig,
  key: CryptoKey,
  definition: ScenarioDefinition,
) {
  const target = options.target.replace(/\/+$/, "");
  const scenario = scenarioName(options, definition);
  await benchmarkRequest(
    target,
    options.token,
    "/prepare",
    {
      scenario,
      layout: definition.layout,
    },
  );

  const runtime = createClient(
    target,
    options.token,
    config,
    key,
    scenario,
    definition,
  );
  try {
    const coldStarted = performance.now();
    const coldDocument = asBenchmarkDocument(
      await runtime.client.get(
        BENCHMARK_COLLECTION,
        BENCHMARK_DOCUMENT_ID,
      ),
    );
    const coldElapsedMs = round(
      performance.now() - coldStarted,
    );
    assertVersion(coldDocument, 0);
    const coldMetrics = metrics(runtime.client);

    runtime.client.resetMetrics();
    const stable = await runStablePhase(
      runtime.client,
      config.stableDurationMs,
      config.readIntervalMs,
      0,
    );
    const stableMetrics = metrics(runtime.client);

    runtime.client.resetMetrics();
    const boundary = await waitForBoundary(
      runtime,
      definition,
      config,
      0,
    );

    await benchmarkRequest(
      target,
      options.token,
      "/mutate",
      {
        scenario,
        layout: definition.layout,
        version: "1",
      },
    );
    const firstMutationAt = performance.now();
    const firstMutation = await detectVersion(
      runtime.client,
      1,
      firstMutationAt,
      config,
    );

    await delay(100);
    await benchmarkRequest(
      target,
      options.token,
      "/mutate",
      {
        scenario,
        layout: definition.layout,
        version: "2",
      },
    );
    const secondMutationAt = performance.now();
    const secondMutation = await detectVersion(
      runtime.client,
      2,
      secondMutationAt,
      config,
    );

    runtime.client.close();
    runtime.transport.offline = true;
    const offlineClient = new ThimbleClient({
      reader: runtime.transport.reader(
        config,
        key,
        scenario,
      ),
      cache: runtime.cache,
      headTtlMs: 0,
      scopeId: BENCHMARK_SCOPE_ID,
      scopeKeyId: config.keyId,
      collectionLayouts: {
        [BENCHMARK_COLLECTION]:
          definition.layout as CollectionLayout,
      },
      layoutGeneration: "adaptive-head-v1",
      configurationCheckedAt: Date.now(),
      layoutCheckTtlMs: Number.MAX_SAFE_INTEGER,
      channelName:
        `adaptive-offline-${crypto.randomUUID()}`,
    });
    const offlineDocument = asBenchmarkDocument(
      await offlineClient.get(
        BENCHMARK_COLLECTION,
        BENCHMARK_DOCUMENT_ID,
      ),
    );
    assertVersion(offlineDocument, 2);
    const offlineMetrics = metrics(offlineClient);
    offlineClient.close();

    return {
      scenario,
      policy: definition.policy,
      layout: definition.layout,
      cold: {
        elapsedMs: coldElapsedMs,
        metrics: coldMetrics,
      },
      stable: {
        ...summariseSamples(stable.samples),
        elapsedMs: stable.elapsedMs,
        operations: stable.samples.length,
        metrics: stableMetrics,
        remoteReadsPerMinute: ratePerMinute(
          stableMetrics.remoteReads,
          stable.elapsedMs,
        ),
        notModifiedPerMinute: ratePerMinute(
          stableMetrics.notModified,
          stable.elapsedMs,
        ),
      },
      boundary,
      firstMutation,
      secondMutation,
      offline: {
        version: offlineDocument?.version ?? null,
        offlineFallbacks:
          offlineMetrics.offlineFallbacks,
        remoteReads: offlineMetrics.remoteReads,
      },
      policyDiagnostics:
        runtime.adaptive?.diagnostics() ?? null,
    };
  } finally {
    runtime.client.close();
    await runtime.cache.clearAll();
  }
}

function createClient(
  target: string,
  token: string,
  config: BenchmarkConfig,
  key: CryptoKey,
  scenario: string,
  definition: ScenarioDefinition,
): ClientRuntime {
  const transport = new TrackingFetch(
    target,
    token,
  );
  const cache = new TieredObjectCache(
    new MemoryObjectCache(),
    new NullPersistentObjectCache(),
    "content",
  );
  let headTtlMs = 1_000;
  let headRevalidationPolicy:
    | HeadRevalidationPolicy
    | undefined;
  let adaptive:
    | ExperimentalAdaptiveHeadRevalidation
    | undefined;

  if (definition.policy === "completion-1s") {
    headRevalidationPolicy =
      new ExperimentalCompletionTimedHeadRevalidation();
  } else if (definition.policy === "fixed-10s") {
    headTtlMs = 10_000;
    headRevalidationPolicy =
      new ExperimentalCompletionTimedHeadRevalidation();
  } else if (
    definition.policy === "adaptive-1-to-10s"
  ) {
    adaptive =
      new ExperimentalAdaptiveHeadRevalidation({
        maximumTtlMs: 10_000,
      });
    headRevalidationPolicy = adaptive;
  }

  const client = new ThimbleClient({
    reader: transport.reader(config, key, scenario),
    cache,
    headTtlMs,
    ...(headRevalidationPolicy
      ? { headRevalidationPolicy }
      : {}),
    scopeId: BENCHMARK_SCOPE_ID,
    scopeKeyId: config.keyId,
    collectionLayouts: {
      [BENCHMARK_COLLECTION]:
        definition.layout as CollectionLayout,
    },
    layoutGeneration: "adaptive-head-v1",
    configurationCheckedAt: Date.now(),
    layoutCheckTtlMs: Number.MAX_SAFE_INTEGER,
    channelName:
      `adaptive-${scenario}-${crypto.randomUUID()}`,
  });
  return {
    client,
    cache,
    transport,
    adaptive,
  };
}

async function runStablePhase(
  client: ThimbleClient,
  durationMs: number,
  intervalMs: number,
  expectedVersion: number,
) {
  const started = performance.now();
  const samples = [];
  while (performance.now() - started < durationMs) {
    samples.push(
      await timedRead(client, expectedVersion),
    );
    await delay(intervalMs);
  }
  return {
    elapsedMs: round(performance.now() - started),
    samples,
  };
}

async function waitForBoundary(
  runtime: ClientRuntime,
  definition: ScenarioDefinition,
  config: BenchmarkConfig,
  expectedVersion: number,
) {
  const started = performance.now();
  const samples = [];
  let previousNotModified =
    runtime.client.metrics().notModified;
  while (
    performance.now() - started <
    config.mutationTimeoutMs * 2
  ) {
    samples.push(
      await timedRead(
        runtime.client,
        expectedVersion,
      ),
    );
    const currentMetrics = runtime.client.metrics();
    const revalidated =
      currentMetrics.notModified >
      previousNotModified;
    previousNotModified =
      currentMetrics.notModified;
    const adaptiveReady =
      definition.policy !==
        "adaptive-1-to-10s" ||
      Object.values(
        runtime.adaptive?.diagnostics()
          .currentTtlMs ?? {},
      ).some((value) => value >= 10_000);
    if (revalidated && adaptiveReady) {
      return {
        elapsedMs: round(
          performance.now() - started,
        ),
        ...summariseSamples(samples),
        operations: samples.length,
        metrics: metrics(runtime.client),
        policyDiagnostics:
          runtime.adaptive?.diagnostics() ?? null,
      };
    }
    await delay(100);
  }
  throw new Error(
    `Revalidation boundary timed out for ${definition.policy}/${definition.layout}`,
  );
}

async function detectVersion(
  client: ThimbleClient,
  expectedVersion: number,
  mutationCompletedAt: number,
  config: BenchmarkConfig,
) {
  client.resetMetrics();
  const samples = [];
  let staleReads = 0;
  while (
    performance.now() - mutationCompletedAt <
    config.mutationTimeoutMs
  ) {
    const started = performance.now();
    const document = asBenchmarkDocument(
      await client.get(
        BENCHMARK_COLLECTION,
        BENCHMARK_DOCUMENT_ID,
      ),
    );
    const sample = {
      elapsedMs: round(
        performance.now() - started,
      ),
      version: document?.version ?? null,
    };
    samples.push(sample);
    if (document?.version === expectedVersion) {
      return {
        detectionDelayMs: round(
          performance.now() - mutationCompletedAt,
        ),
        staleReads,
        ...summariseSamples(samples),
        operations: samples.length,
        metrics: metrics(client),
        samples,
      };
    }
    staleReads += 1;
    await delay(config.readIntervalMs);
  }
  throw new Error(
    `Version ${expectedVersion} was not visible within ${config.mutationTimeoutMs} ms`,
  );
}

async function timedRead(
  client: ThimbleClient,
  expectedVersion: number,
) {
  const started = performance.now();
  const document = asBenchmarkDocument(
    await client.get(
      BENCHMARK_COLLECTION,
      BENCHMARK_DOCUMENT_ID,
    ),
  );
  assertVersion(document, expectedVersion);
  return {
    elapsedMs: round(
      performance.now() - started,
    ),
    version: document.version,
  };
}

function metrics(client: ThimbleClient) {
  const value = client.metrics();
  return {
    remoteReads: value.remoteReads,
    remoteBytes: value.remoteBytes,
    notModified: value.notModified,
    missing: value.missing,
    offlineFallbacks: value.offlineFallbacks,
    cache: value.cache,
  };
}

function summariseSamples(
  samples: Array<{ elapsedMs: number }>,
) {
  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    meanMs: mean(elapsed),
    maxMs: elapsed.at(-1) ?? 0,
    samples,
  };
}

async function benchmarkRequest(
  target: string,
  token: string,
  pathname: string,
  parameters: Record<string, string>,
) {
  const url = new URL(pathname, target);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "x-benchmark-token": token,
    },
  });
  if (!response.ok) {
    throw new Error(
      `${pathname} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function securityChecks(target: string) {
  const config = await fetch(
    `${target}/benchmark-config.json`,
    { cache: "no-store" },
  );
  const prepare = await fetch(
    `${target}/prepare?scenario=unauthorised&layout=trie`,
    {
      method: "POST",
      cache: "no-store",
    },
  );
  if (config.status !== 403 || prepare.status !== 403) {
    throw new Error(
      "Benchmark configuration or mutation route was accessible without authorization",
    );
  }
  return {
    configWithoutToken: config.status,
    prepareWithoutToken: prepare.status,
  };
}

class TrackingFetch {
  offline = false;

  constructor(
    private readonly target: string,
    private readonly token: string,
  ) {}

  reader(
    config: BenchmarkConfig,
    key: CryptoKey,
    scenario: string,
  ) {
    return new ScopedJsonObjectReader(
      new EnvelopeJsonObjectReader(
        new HttpByteObjectReader(
          `${this.target}/data/${encodeURIComponent(scenario)}`,
          this.fetch,
          this.target,
        ),
        (keyId) =>
          keyId === config.keyId ? key : null,
        config.decodedObjectLimit,
      ),
      BENCHMARK_SCOPE_ID,
    );
  }

  readonly fetch: typeof fetch = async (
    input,
    init = {},
  ) => {
    if (this.offline) {
      throw new TypeError("offline");
    }
    const headers = new Headers(init.headers);
    headers.set("x-benchmark-token", this.token);
    return fetch(input, {
      ...init,
      cache: "no-store",
      headers,
    });
  };
}

class NullPersistentObjectCache
implements PersistentObjectCache {
  get() {
    return Promise.resolve(null);
  }

  set() {
    return Promise.resolve();
  }

  delete() {
    return Promise.resolve();
  }

  clear() {
    return Promise.resolve();
  }

  destroy() {
    return Promise.resolve();
  }
}

function assertVersion(
  document: BenchmarkDocument | null,
  expectedVersion: number,
): asserts document is BenchmarkDocument {
  if (
    !document ||
    document.id !== BENCHMARK_DOCUMENT_ID ||
    document.version !== expectedVersion
  ) {
    throw new Error(
      `Expected version ${expectedVersion}, received ${document?.version ?? "missing"}`,
    );
  }

  function asBenchmarkDocument(
    document: import("../../src/core.js").JsonDocument | null,
  ): BenchmarkDocument | null {
    if (
      !document ||
      typeof document.version !== "number"
    ) {
      return null;
    }
    return {
      id: document.id,
      version: document.version,
    };
  }
}

function scenarioName(
  options: BrowserBenchmarkOptions,
  definition: ScenarioDefinition,
) {
  return [
    options.replicate,
    options.region,
    definition.policy,
    definition.layout,
  ].join("-").slice(0, 80);
}

function ratePerMinute(
  count: number,
  elapsedMs: number,
) {
  return elapsedMs <= 0
    ? 0
    : Number(
        ((count * 60_000) / elapsedMs).toFixed(3),
      );
}

function percentile(
  values: number[],
  quantile: number,
) {
  if (values.length === 0) {
    return 0;
  }
  return values[
    Math.min(
      values.length - 1,
      Math.ceil(values.length * quantile) - 1,
    )
  ]!;
}

function mean(values: number[]) {
  return values.length === 0
    ? 0
    : Number(
        (
          values.reduce(
            (total, value) => total + value,
            0,
          ) / values.length
        ).toFixed(3),
      );
}

function rotate<T>(
  values: readonly T[],
  offset: number,
) {
  return [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ];
}

function hashOffset(
  value: string,
  divisor: number,
) {
  let hash = 0;
  for (const character of value) {
    hash =
      (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % divisor;
}

function delay(milliseconds: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}

function round(value: number) {
  return Number(value.toFixed(3));
}
