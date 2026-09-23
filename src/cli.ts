import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectStore } from "./core.js";
import { runBenchmark, type EngineFactory } from "./benchmark.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { LogSnapshotEngine } from "./engines/log-snapshot.js";
import { MonolithEngine } from "./engines/monolith.js";
import {
  AzureBlobObjectStore,
  LocalObjectStore,
  PrefixObjectStore,
  S3ObjectStore,
} from "./stores.js";
import { round } from "./utils.js";
import { workloadProfiles } from "./workload.js";

type Provider = "local" | "azure" | "s3";

const args = parseArgs(process.argv.slice(2));
const provider = readProvider(args.provider ?? "local");
const profileName = args.profile === "small" ? "small" : "tiny";
const profile = workloadProfiles[profileName];
const latencyMs = numberArgument(
  args["latency-ms"],
  provider === "local" ? 8 : 0,
);
const mutableCacheTtlMs = numberArgument(
  args["mutable-cache-ttl-ms"],
  1_000,
);
const cacheMaxMb = numberArgument(args["cache-max-mb"], 64);
const runId =
  args["run-id"] ??
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

const baseStore = createBaseStore(provider);
const factories: EngineFactory[] = [
  {
    name: "monolithic-json",
    create: (store) => new MonolithEngine(store),
  },
  {
    name: "append-log-snapshot",
    create: (store) => new LogSnapshotEngine(store),
  },
  {
    name: "content-addressed-trie",
    create: (store) => new ContentAddressedTrieEngine(store),
  },
];

console.log(
  `Running ${profile.name} workload on ${provider}` +
    (latencyMs > 0 ? ` with ${latencyMs} ms simulated operation latency` : ""),
);

const result = await runBenchmark({
  provider,
  profile,
  simulatedLatencyMs: latencyMs,
  mutableCacheTtlMs,
  cacheMaxBytes: cacheMaxMb * 1024 * 1024,
  factories,
  createStore(engineName) {
    return new PrefixObjectStore(
      baseStore,
      `object-db-poc/${runId}/${engineName}`,
    );
  },
});

printResults(result);

const resultsDirectory = path.resolve("benchmark-results");
await mkdir(resultsDirectory, { recursive: true });
const outputPath = path.join(resultsDirectory, `${runId}.json`);
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nRaw result: ${outputPath}`);

function createBaseStore(providerName: Provider): ObjectStore {
  if (providerName === "local") {
    return new LocalObjectStore(path.resolve(".bench-data"));
  }

  if (providerName === "azure") {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error(
        "Set AZURE_STORAGE_CONNECTION_STRING in the shell before running the Azure benchmark",
      );
    }
    return new AzureBlobObjectStore(
      connectionString,
      process.env.AZURE_STORAGE_CONTAINER ?? "object-db-poc",
    );
  }

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "Set S3_BUCKET and use the normal AWS credential environment or profile before running the S3 benchmark",
    );
  }
  const clientConfig: {
    region: string;
    endpoint?: string;
    forcePathStyle?: boolean;
  } = {
    region: process.env.AWS_REGION ?? "us-east-1",
  };
  if (process.env.S3_ENDPOINT) {
    clientConfig.endpoint = process.env.S3_ENDPOINT;
  }
  if (process.env.S3_FORCE_PATH_STYLE) {
    clientConfig.forcePathStyle =
      process.env.S3_FORCE_PATH_STYLE.toLowerCase() === "true";
  }
  return new S3ObjectStore({ bucket, clientConfig });
}

function printResults(result: Awaited<ReturnType<typeof runBenchmark>>): void {
  const phaseRows = result.engines.flatMap((engine) =>
    engine.phases.map((phase) => ({
      engine: engine.engine,
      phase: phase.name,
      "total ms": phase.durationMs,
      "p50 ms": phase.latencyP50Ms,
      "p95 ms": phase.latencyP95Ms,
      GETs: phase.store.get.count,
      PUTs: phase.store.put.count,
      DELETEs: phase.store.delete.count,
      conflicts: phase.store.preconditionFailures,
      cache: phase.cache.policy,
      "cache hit %": cacheHitRate(phase.cache),
      "read KB": round(phase.store.get.bytes / 1024),
      "written KB": round(phase.store.put.bytes / 1024),
    })),
  );
  console.table(phaseRows);

  console.table(
    result.engines.map((engine) => ({
      engine: engine.engine,
      objects: engine.finalObjectCount,
      "stored KB": round(engine.finalStoredBytes / 1024),
      diagnostics: formatDiagnostics(engine.diagnostics),
    })),
  );

  console.log("\nDecision indicators");
  console.table(
    result.engines.map((engine) => {
      const cold = phase(engine, "cold-point-read");
      const locations = phase(engine, "location-cache-point-read");
      const content = phase(engine, "content-cache-point-read");
      const updates = phase(engine, "sequential-updates");
      const concurrent = phase(engine, "concurrent-writes");
      return {
        engine: engine.engine,
        "cold p50 ms": cold.latencyP50Ms,
        "location p50 ms": locations.latencyP50Ms,
        "content p50 ms": content.latencyP50Ms,
        "location read KB/op": perOperationKb(
          locations.store.get.bytes,
          locations.operationCount,
        ),
        "update write KB/op": perOperationKb(
          updates.store.put.bytes,
          updates.operationCount,
        ),
        "concurrent p95 ms": concurrent.latencyP95Ms,
        conflicts: concurrent.store.preconditionFailures,
        objects: engine.finalObjectCount,
        "stored KB": round(engine.finalStoredBytes / 1024),
      };
    }),
  );
}

function cacheHitRate(cache: {
  hits: number;
  misses: number;
}): number {
  const total = cache.hits + cache.misses;
  return total === 0 ? 0 : round((cache.hits / total) * 100);
}

function phase(
  engine: Awaited<ReturnType<typeof runBenchmark>>["engines"][number],
  name: string,
) {
  const result = engine.phases.find((candidate) => candidate.name === name);
  if (!result) {
    throw new Error(`Benchmark result is missing phase ${name}`);
  }
  return result;
}

function perOperationKb(bytes: number, operations: number): number {
  return operations === 0 ? 0 : round(bytes / 1024 / operations, 3);
}

function formatDiagnostics(
  diagnostics: Record<string, number>,
): string {
  return Object.entries(diagnostics)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) {
      continue;
    }
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      parsed[withoutPrefix.slice(0, equalsIndex)] =
        withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = "true";
    }
  }
  return parsed;
}

function readProvider(value: string): Provider {
  if (value === "local" || value === "azure" || value === "s3") {
    return value;
  }
  throw new Error(`Unknown provider: ${value}`);
}

function numberArgument(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, received ${value}`);
  }
  return parsed;
}
