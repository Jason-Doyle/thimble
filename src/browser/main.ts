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

type AuthConfig = {
  local: {
    enabled: boolean;
    registrationEnabled: boolean;
    minimumPasswordBytes: number;
  };
  oidcProviders: string[];
};

type BrowserConfig = {
  name: string;
  provider: "local" | "azure" | "s3" | "r2";
  readBaseUrl: string;
  headTtlMs: number;
  cachePolicy: CachePolicy;
  csrfToken: string;
  user: {
    id: string;
    provider: string;
    roles: string[];
    tenants: string[];
  };
  scope: {
    id: string;
    encrypted: boolean;
    keyId: string | null;
    keyEndpoint: string | null;
  };
};

const status = element<HTMLDivElement>("status");
const authPanel = element<HTMLElement>("auth-panel");
const authLogin = element<HTMLInputElement>("auth-login");
const authPassword = element<HTMLInputElement>("auth-password");
const authMessage = element<HTMLParagraphElement>("auth-message");
const cachePolicy = element<HTMLSelectElement>("cache-policy");
const productId = element<HTMLInputElement>("product-id");
const productOutput = element<HTMLPreElement>("product-output");
const benchmarkOutput =
  element<HTMLPreElement>("benchmark-output");
const metricsOutput = element<HTMLDivElement>("metrics");

let client: ThimbleClient | null = null;
let config: BrowserConfig | null = null;

await bootstrap();

element<HTMLButtonElement>("login").addEventListener(
  "click",
  async () => {
    await authenticate("/api/auth/login", "Signing in...");
  },
);

element<HTMLButtonElement>("register").addEventListener(
  "click",
  async () => {
    setStatus("Creating account...", "working");
    const response = await fetch("/api/auth/register", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        login: authLogin.value,
        password: authPassword.value,
      }),
    });
    const result = await response.json().catch(() => ({})) as {
      message?: string;
    };
    authMessage.textContent =
      result.message ??
      "If registration is available, the account can now sign in.";
    setStatus(
      response.ok ? "Registration request complete" : "Registration failed",
      response.ok ? "ready" : "error",
    );
  },
);

cachePolicy.addEventListener("change", () => {
  requireClient().setCachePolicy(cachePolicy.value as CachePolicy);
  renderMetrics();
});

element<HTMLButtonElement>("seed").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const current = requireConfig();
      const response = await fetch("/api/seed?profile=tiny", {
        method: "POST",
        credentials: "same-origin",
        headers: mutationHeaders(current),
        body: "{}",
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await requireClient().clearAll();
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
    requireClient().clearMemory();
    renderMetrics();
    setStatus("Memory cache cleared", "ready");
  },
);

element<HTMLButtonElement>("clear-all").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      await requireClient().clearAll();
    }, "Memory and IndexedDB caches cleared");
  },
);

element<HTMLButtonElement>("logout").addEventListener(
  "click",
  async () => {
    const current = requireConfig();
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: mutationHeaders(current),
      body: "{}",
    });
    if (!response.ok) {
      setStatus("Sign out failed", "error");
      return;
    }
    await requireClient().logout();
  },
);

element<HTMLButtonElement>("read-product").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const started = performance.now();
      const product = await requireClient().get(
        "products",
        productId.value,
      );
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
      const database = requireClient();
      const existing = await database.get(
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
      const bundle = await database.write(
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
      const database = requireClient();
      const latencies: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const id = `product-${(index % 8)
          .toString()
          .padStart(5, "0")}`;
        const started = performance.now();
        const product = await database.get("products", id);
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
          metrics: database.metrics(),
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
      const database = requireClient();
      const started = performance.now();
      const products = await database.scan("products");
      benchmarkOutput.textContent = JSON.stringify(
        {
          elapsedMs: round(performance.now() - started),
          documents: products.length,
          firstIds: products
            .slice(0, 10)
            .map((product) => product.id),
          metrics: database.metrics(),
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
    requireClient().resetMetrics();
    renderMetrics();
    setStatus("Metrics reset", "ready");
  },
);

async function bootstrap(): Promise<void> {
  const auth = await fetchJson<AuthConfig>("/api/auth/config");
  const response = await fetch("/api/config", {
    credentials: "same-origin",
  });
  if (response.status === 401) {
    authPanel.hidden = false;
    element<HTMLButtonElement>("register").hidden =
      !auth.local.registrationEnabled;
    setStatus("Sign in required", "ready");
    return;
  }
  if (!response.ok) {
    throw new Error(`Config request failed with ${response.status}`);
  }

  config = (await response.json()) as BrowserConfig;
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
    csrfToken: config.csrfToken,
    scopeId: config.scope.id,
    ...(scopeKey
      ? { keyExpiresAt: scopeKey.expiresAt }
      : {}),
    channelName: `thimbledb:${namespace}`,
    onLogout: () => window.location.reload(),
  });
  const persistentStorage =
    await navigator.storage?.persist?.().catch(() => false);
  cachePolicy.value = config.cachePolicy;
  for (const section of document.querySelectorAll<HTMLElement>(
    ".authenticated",
  )) {
    section.hidden = false;
  }
  setStatus(
    `Ready: ${config.provider}, ${config.scope.encrypted ? `encrypted ${config.scope.keyId}` : "public"}, signed in with ${config.user.provider}, persistent cache ${persistentStorage ? "granted" : "best effort"}`,
    "ready",
  );
  renderMetrics();
}

async function authenticate(
  endpoint: string,
  statusMessage: string,
): Promise<void> {
  setStatus(statusMessage, "working");
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      login: authLogin.value,
      password: authPassword.value,
    }),
  });
  if (!response.ok) {
    authMessage.textContent = "Invalid login or password";
    setStatus("Sign in failed", "error");
    return;
  }
  window.location.reload();
}

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

async function loadScopeKey(
  current: BrowserConfig,
): Promise<{
  keyId: string;
  key: CryptoKey;
  expiresAt: string;
} | null> {
  if (!current.scope.encrypted) {
    return null;
  }
  if (!current.scope.keyId || !current.scope.keyEndpoint) {
    throw new Error("Encrypted scope is missing its key grant endpoint");
  }
  const response = await fetch(current.scope.keyEndpoint, {
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
    expiresAt: string;
  };
  if (
    grant.scopeId !== current.scope.id ||
    grant.keyId !== current.scope.keyId ||
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
    expiresAt: grant.expiresAt,
  };
}

function mutationHeaders(
  current: BrowserConfig,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-thimble-csrf": current.csrfToken,
    "x-thimble-scope": current.scope.id,
  };
}

function cacheNamespace(current: BrowserConfig): string {
  const url = new URL(
    current.readBaseUrl,
    window.location.href,
  );
  return `${current.provider}:${url.origin}${url.pathname}:${current.scope.id}:${current.scope.keyId ?? "public"}`;
}

function requireClient(): ThimbleClient {
  if (!client) {
    throw new Error("Authentication is required");
  }
  return client;
}

function requireConfig(): BrowserConfig {
  if (!config) {
    throw new Error("Authentication is required");
  }
  return config;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
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
