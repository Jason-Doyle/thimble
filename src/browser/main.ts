import type {
  CachePolicy,
  JsonDocument,
} from "../core.js";
import {
  base64ToBytes,
  importAesGcmKey,
} from "../envelope.js";
import {
  IndexedDbObjectCache,
  MemoryObjectCache,
  TieredObjectCache,
} from "./cache.js";
import { ThimbleClient } from "./client.js";
import {
  EnvelopeJsonObjectReader,
  HttpByteObjectReader,
  ScopedJsonObjectReader,
} from "./remote-reader.js";

type BrowserConfig = {
  name: string;
  provider: "local" | "azure" | "s3" | "r2";
  readBaseUrl: string;
  headTtlMs: number;
  cachePolicy: CachePolicy;
  scope: {
    id: string;
    encrypted: boolean;
    keyId: string | null;
    keyEndpoint: string | null;
  };
};

const status = element<HTMLDivElement>("status");
const cachePolicy = element<HTMLSelectElement>("cache-policy");
const productId = element<HTMLInputElement>("product-id");
const productOutput = element<HTMLPreElement>("product-output");
const benchmarkOutput =
  element<HTMLPreElement>("benchmark-output");
const metricsOutput = element<HTMLDivElement>("metrics");

let client: ThimbleClient;

try {
  const config = await loadConfig();
  if (!config.readBaseUrl) {
    throw new Error(
      "The server has no browser read URL. Set THIMBLE_READ_BASE_URL for Azure.",
    );
  }
  const namespace = cacheNamespace(config);
  const scopeKey = await loadScopeKey(config);
  const envelopeReader = new EnvelopeJsonObjectReader(
    new HttpByteObjectReader(config.readBaseUrl),
    scopeKey
      ? (keyId) =>
          keyId === scopeKey.keyId ? scopeKey.key : null
      : undefined,
  );
  const cache = new TieredObjectCache(
    new MemoryObjectCache(),
    new IndexedDbObjectCache(namespace),
    config.cachePolicy,
  );
  client = new ThimbleClient({
    reader: new ScopedJsonObjectReader(
      envelopeReader,
      config.scope.id,
    ),
    cache,
    headTtlMs: config.headTtlMs,
    channelName: `thimbledb:${namespace}`,
  });
  const persistentStorage =
    await navigator.storage?.persist?.().catch(() => false);
  cachePolicy.value = config.cachePolicy;
  setStatus(
    `Ready: ${config.provider}, ${config.scope.encrypted ? `encrypted ${config.scope.keyId}` : "public"}, HEAD TTL ${config.headTtlMs} ms, persistent cache ${persistentStorage ? "granted" : "best effort"}`,
    "ready",
  );
  renderMetrics();
} catch (error) {
  setStatus(errorMessage(error), "error");
  throw error;
}

cachePolicy.addEventListener("change", () => {
  client.setCachePolicy(cachePolicy.value as CachePolicy);
  renderMetrics();
});

element<HTMLButtonElement>("seed").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const response = await fetch("/api/seed?profile=tiny", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await client.clearAll();
      benchmarkOutput.textContent = JSON.stringify(
        await response.json(),
        null,
        2,
      );
    }, "Seeded store");
  },
);

element<HTMLButtonElement>("clear-memory").addEventListener(
  "click",
  () => {
    client.clearMemory();
    renderMetrics();
    setStatus("Memory cache cleared", "ready");
  },
);

element<HTMLButtonElement>("clear-all").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      await client.clearAll();
    }, "Memory and IndexedDB caches cleared");
  },
);

element<HTMLButtonElement>("read-product").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const started = performance.now();
      const product = await client.get("products", productId.value);
      productOutput.textContent = JSON.stringify(
        {
          elapsedMs: round(performance.now() - started),
          product,
        },
        null,
        2,
      );
    }, "Product loaded");
  },
);

element<HTMLButtonElement>("update-stock").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const existing = await client.get(
        "products",
        productId.value,
      );
      if (!existing) {
        throw new Error(`Product ${productId.value} was not found`);
      }
      const stock =
        typeof existing.stock === "number" ? existing.stock : 0;
      const updated: JsonDocument = {
        ...existing,
        stock: Math.max(0, stock - 1),
        updatedAt: new Date().toISOString(),
      };
      const bundle = await client.write(
        "products",
        updated.id,
        updated,
      );
      productOutput.textContent = JSON.stringify(
        {
          revision: bundle.revision,
          product: bundle.document,
          cacheObjectsApplied: bundle.objects.length,
        },
        null,
        2,
      );
    }, "Stock updated through write authority");
  },
);

element<HTMLButtonElement>("benchmark-reads").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const latencies: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const id = `product-${(index % 8)
          .toString()
          .padStart(5, "0")}`;
        const started = performance.now();
        const product = await client.get("products", id);
        latencies.push(performance.now() - started);
        if (!product) {
          throw new Error(`Product ${id} was not found`);
        }
      }
      benchmarkOutput.textContent = JSON.stringify(
        {
          operations: latencies.length,
          p50Ms: round(percentile(latencies, 50)),
          p95Ms: round(percentile(latencies, 95)),
          maxMs: round(Math.max(...latencies)),
          metrics: client.metrics(),
        },
        null,
        2,
      );
    }, "Hot-read benchmark complete");
  },
);

element<HTMLButtonElement>("scan-products").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const started = performance.now();
      const products = await client.scan("products");
      benchmarkOutput.textContent = JSON.stringify(
        {
          elapsedMs: round(performance.now() - started),
          documents: products.length,
          firstIds: products.slice(0, 10).map((product) => product.id),
          metrics: client.metrics(),
        },
        null,
        2,
      );
    }, "Product scan complete");
  },
);

element<HTMLButtonElement>("reset-metrics").addEventListener(
  "click",
  () => {
    client.resetMetrics();
    renderMetrics();
    setStatus("Metrics reset", "ready");
  },
);

async function runUiAction(
  action: () => Promise<void>,
  successMessage: string,
): Promise<void> {
  setStatus("Working...", "working");
  try {
    await action();
    setStatus(successMessage, "ready");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    renderMetrics();
  }
}

function renderMetrics(): void {
  if (!client) {
    return;
  }
  const metrics = client.metrics();
  const values = [
    ["Cache policy", metrics.cache.policy],
    ["Memory hits", metrics.cache.memoryHits],
    ["IndexedDB hits", metrics.cache.indexedDbHits],
    ["Cache misses", metrics.cache.misses],
    ["Remote reads", metrics.remoteReads],
    ["Remote bytes", formatBytes(metrics.remoteBytes)],
    ["HEAD 304s", metrics.notModified],
    ["Offline fallbacks", metrics.offlineFallbacks],
    ["Memory entries", metrics.cache.memoryEntries],
    ["Memory size", formatBytes(metrics.cache.memoryBytes)],
    ["Evictions", metrics.cache.evictions],
  ];
  metricsOutput.replaceChildren(
    ...values.map(([label, value]) => {
      const card = document.createElement("div");
      card.className = "metric";
      const title = document.createElement("span");
      title.textContent = String(label);
      const output = document.createElement("strong");
      output.textContent = String(value);
      card.append(title, output);
      return card;
    }),
  );
}

async function loadConfig(): Promise<BrowserConfig> {
  const response = await fetch("/api/config", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Config request failed with ${response.status}`);
  }
  return (await response.json()) as BrowserConfig;
}

async function loadScopeKey(
  config: BrowserConfig,
): Promise<{ keyId: string; key: CryptoKey } | null> {
  if (!config.scope.encrypted) {
    return null;
  }
  if (!config.scope.keyId || !config.scope.keyEndpoint) {
    throw new Error("Encrypted scope is missing its key grant endpoint");
  }
  const response = await fetch(config.scope.keyEndpoint, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Scope key request failed with ${response.status}`,
    );
  }
  const grant = (await response.json()) as {
    scopeId: string;
    keyId: string;
    key: string;
    algorithm: string;
  };
  if (
    grant.scopeId !== config.scope.id ||
    grant.keyId !== config.scope.keyId ||
    grant.algorithm !== "A256GCM"
  ) {
    throw new Error("Scope key grant does not match browser config");
  }
  const rawKey = base64ToBytes(grant.key);
  grant.key = "";
  const key = await importAesGcmKey(
    rawKey,
    ["decrypt"],
    false,
  );
  rawKey.fill(0);
  return {
    keyId: grant.keyId,
    key,
  };
}

function cacheNamespace(config: BrowserConfig): string {
  const url = new URL(config.readBaseUrl, window.location.href);
  return `${config.provider}:${url.origin}${url.pathname}:${config.scope.id}:${config.scope.keyId ?? "public"}`;
}

function setStatus(
  message: string,
  state: "ready" | "working" | "error",
): void {
  status.textContent = message;
  status.dataset.state = state;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element #${id}`);
  }
  return value as T;
}

function percentile(values: number[], percentage: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${round(bytes / 1024)} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
