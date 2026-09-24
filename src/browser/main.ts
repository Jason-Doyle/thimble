import type {
  CachePolicy,
  JsonDocument,
} from "../core.js";
import { ThimbleClient } from "./client.js";
import {
  createThimbleConnection,
  ThimbleConnectionError,
  type ThimbleAuthorityConfig,
} from "./connect.js";

type AuthConfig = {
  oidcProviders: string[];
  developmentIdentity?: boolean;
};

type IdentitySummary = {
  provider: string;
  issuer: string;
  subject: string;
};

type AdminUser = {
  id: string;
  status: "active" | "disabled";
  authVersion: number;
  roles: string[];
  tenants: string[];
  identities: Array<
    IdentitySummary & {
      roles: string[];
      tenants: string[];
    }
  >;
  createdAt: string;
  updatedAt: string;
};

type BrowserConfig = ThimbleAuthorityConfig;

const status = element<HTMLDivElement>("status");
const authPanel = element<HTMLElement>("auth-panel");
const externalAuthControls =
  element<HTMLElement>("external-auth-controls");
const authProvider =
  element<HTMLSelectElement>("auth-provider");
const authToken = element<HTMLTextAreaElement>("auth-token");
const authMessage = element<HTMLParagraphElement>("auth-message");
const devLogin = element<HTMLButtonElement>("dev-login");
const identityOutput =
  element<HTMLPreElement>("identity-output");
const linkProvider =
  element<HTMLSelectElement>("link-provider");
const linkToken = element<HTMLTextAreaElement>("link-token");
const unlinkIdentity =
  element<HTMLSelectElement>("unlink-identity");
const adminPanel = element<HTMLElement>("admin-panel");
const adminUser = element<HTMLSelectElement>("admin-user");
const adminStatus =
  element<HTMLSelectElement>("admin-status");
const adminRoles = element<HTMLInputElement>("admin-roles");
const adminTenants =
  element<HTMLInputElement>("admin-tenants");
const adminOutput = element<HTMLPreElement>("admin-output");
const cachePolicy = element<HTMLSelectElement>("cache-policy");
const productId = element<HTMLInputElement>("product-id");
const productOutput = element<HTMLPreElement>("product-output");
const benchmarkOutput =
  element<HTMLPreElement>("benchmark-output");
const metricsOutput = element<HTMLDivElement>("metrics");

let client: ThimbleClient | null = null;
let config: BrowserConfig | null = null;
let authConfig: AuthConfig | null = null;
let adminUsers: AdminUser[] = [];

try {
  await bootstrap();
} catch (error) {
  authPanel.hidden = false;
  authMessage.textContent = errorMessage(error);
  setStatus("Startup failed", "error");
}

element<HTMLButtonElement>("oidc-login").addEventListener(
  "click",
  async () => {
    await authenticateExternal();
  },
);

devLogin.addEventListener("click", async () => {
  await authenticateDevelopment();
});

element<HTMLButtonElement>("link-identity").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const current = requireConfig();
      const provider = linkProvider.value;
      const token = linkToken.value.trim();
      if (!provider || !token) {
        throw new Error(
          "Select a provider and supply a fresh access token",
        );
      }
      const response = await fetch(
        `/api/auth/identities/${encodeURIComponent(provider)}/link`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            ...mutationHeaders(current),
            authorization: `Bearer ${token}`,
          },
          body: "{}",
        },
      );
      if (!response.ok) {
        throw new Error(await response.text());
      }
      linkToken.value = "";
      window.location.reload();
    }, "External identity linked");
  },
);

element<HTMLButtonElement>("unlink-identity-button").addEventListener(
  "click",
  async () => {
    const current = requireConfig();
    const selected = unlinkIdentity.value;
    if (!selected) {
      setStatus("Select an identity to unlink", "error");
      return;
    }
    const response = await fetch(
      "/api/auth/identities/unlink",
      {
        method: "POST",
        credentials: "same-origin",
        headers: mutationHeaders(current),
        body: selected,
      },
    );
    if (!response.ok) {
      setStatus(await response.text(), "error");
      return;
    }
    await requireClient().logout();
  },
);

element<HTMLButtonElement>("load-admin-users").addEventListener(
  "click",
  async () => {
    await loadAdminUsers();
  },
);

adminUser.addEventListener("change", renderSelectedAdminUser);

element<HTMLButtonElement>("save-admin-user").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const current = requireConfig();
      const userId = adminUser.value;
      if (!userId) {
        throw new Error("Select a user");
      }
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: mutationHeaders(current),
        body: JSON.stringify({
          status: adminStatus.value,
          roles: commaSeparated(adminRoles.value),
          tenants: commaSeparated(adminTenants.value),
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      if (userId === current.user.id) {
        await requireClient().logout();
        return;
      }
      await loadAdminUsers();
    }, "User access updated");
  },
);

element<HTMLButtonElement>("revoke-admin-sessions").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const current = requireConfig();
      const userId = adminUser.value;
      if (!userId) {
        throw new Error("Select a user");
      }
      const response = await fetch(
        `/api/admin/users/${userId}/revoke-sessions`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: mutationHeaders(current),
          body: "{}",
        },
      );
      if (!response.ok) {
        throw new Error(await response.text());
      }
      if (userId === current.user.id) {
        await requireClient().logout();
      }
    }, "User sessions revoked");
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
    const database = requireClient();
    let serverFailure = false;
    try {
      const current = requireConfig();
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: mutationHeaders(current),
        body: "{}",
      });
      if (!response.ok) {
        serverFailure = true;
      }
    } catch {
      serverFailure = true;
    }
    try {
      await database.logout();
      if (serverFailure) {
        setStatus(
          "Server sign out failed; local data was cleared",
          "error",
        );
      }
    } catch {
      setStatus(
        "Signed out, but local cache purge failed",
        "error",
      );
    }
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

element<HTMLButtonElement>("delete-product").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const bundle = await requireClient().delete(
        "products",
        productId.value,
      );
      productOutput.textContent = JSON.stringify(
        {
          revision: bundle.revision,
          deleted: bundle.document === null,
        },
        null,
        2,
      );
    }, "Product deleted with retention tombstone");
  },
);

element<HTMLButtonElement>("restore-product").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const bundle = await requireClient().restore(
        "products",
        productId.value,
      );
      productOutput.textContent = JSON.stringify(
        {
          revision: bundle.revision,
          product: bundle.document,
        },
        null,
        2,
      );
    }, "Product restored");
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

element<HTMLButtonElement>("scan-customers").addEventListener(
  "click",
  async () => {
    await runUiAction(async () => {
      const database = requireClient();
      const started = performance.now();
      const customers = await database.scan("customers");
      benchmarkOutput.textContent = JSON.stringify(
        {
          collection: "customers",
          layout:
            requireConfig().collectionLayouts.customers ?? "trie",
          elapsedMs: round(performance.now() - started),
          documents: customers.length,
          metrics: database.metrics(),
        },
        null,
        2,
      );
    }, "Customer snapshot scan complete");
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
  authConfig = auth;
  let connection;
  try {
    connection = await createThimbleConnection({
      onLogout: (error) => showSignedOut(error),
      onLayoutChange: () => window.location.reload(),
    });
  } catch (error) {
    if (
      error instanceof ThimbleConnectionError &&
      error.status === 401
    ) {
      authPanel.hidden = false;
      renderAuthProviders(auth);
      setStatus("Sign in required", "ready");
      return;
    }
    throw error;
  }
  config = connection.config;
  client = connection.client;
  const cache = connection.cache;
  const persistentStorage = await requestPersistentStorage();
  cachePolicy.value = config.cachePolicy;
  for (const section of document.querySelectorAll<HTMLElement>(
    ".authenticated",
  )) {
    section.hidden =
      section.dataset.admin === "true" &&
      !config.user.roles.includes("thimble.admin");
  }
  renderIdentityControls(config);
  if (config.user.roles.includes("thimble.admin")) {
    await loadAdminUsers();
  }
  setStatus(
    `Ready: ${config.provider}, ${config.scope.encrypted ? `encrypted ${config.scope.keyId}` : "public"}, signed in with ${config.user.provider}, persistent cache ${persistentStorage ? "granted" : "best effort"}`,
    "ready",
  );
  renderMetrics();
}

async function authenticateExternal(): Promise<void> {
  try {
    const provider = authProvider.value;
    const token = authToken.value.trim();
    if (!provider || !token) {
      throw new Error("Select a provider and supply an access token");
    }

    setStatus("Validating external identity...", "working");
    const response = await fetch(
      `/api/auth/oidc/${encodeURIComponent(provider)}/session`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{}",
      },
    );
    if (!response.ok) {
      authMessage.textContent =
        "The identity provider token was not accepted.";
      setStatus("Sign in failed", "error");
      return;
    }
    window.location.reload();
  } catch (error) {
    authMessage.textContent = errorMessage(error);
    setStatus("Sign in failed", "error");
  }
}

async function authenticateDevelopment(): Promise<void> {
  try {
    setStatus("Creating local development session...", "working");
    const response = await fetch("/api/auth/dev/session", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!response.ok) {
      throw new Error(
        `Development sign in failed with ${response.status}`,
      );
    }
    window.location.reload();
  } catch (error) {
    authMessage.textContent = errorMessage(error);
    setStatus("Development sign in failed", "error");
  }
}

function renderIdentityControls(current: BrowserConfig): void {
  identityOutput.textContent = JSON.stringify(
    current.user.identities,
    null,
    2,
  );
  linkProvider.replaceChildren(
    ...externalProviderIds(authConfig).map((provider) => {
      const option = document.createElement("option");
      option.value = provider;
      option.textContent = provider;
      return option;
    }),
  );
  unlinkIdentity.replaceChildren(
    ...current.user.identities.map((identity) => {
      const option = document.createElement("option");
      option.value = JSON.stringify(identity);
      option.textContent =
        `${identity.provider}: ${identity.subject}`;
      return option;
    }),
  );
  element<HTMLButtonElement>("unlink-identity-button").disabled =
    current.user.identities.length <= 1;
}

async function loadAdminUsers(): Promise<void> {
  const response = await fetch("/api/admin/users", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = (await response.json()) as {
    users: AdminUser[];
  };
  adminUsers = result.users;
  adminUser.replaceChildren(
    ...adminUsers.map((user) => {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = `${user.id} (${user.status})`;
      return option;
    }),
  );
  adminPanel.hidden = false;
  renderSelectedAdminUser();
}

function renderSelectedAdminUser(): void {
  const selected = adminUsers.find(
    (user) => user.id === adminUser.value,
  );
  if (!selected) {
    adminOutput.textContent = "No users loaded.";
    return;
  }
  adminStatus.value = selected.status;
  adminRoles.value = selected.roles.join(", ");
  adminTenants.value = selected.tenants.join(", ");
  adminOutput.textContent = JSON.stringify(selected, null, 2);
}

function commaSeparated(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
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
    ["Persistent cache errors", metrics.cache.persistentErrors],
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

function mutationHeaders(
  current: BrowserConfig,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-thimble-csrf": current.csrfToken,
    "x-thimble-scope": current.scope.id,
    "x-thimble-layout-generation": current.layoutGeneration,
  };
}

function showSignedOut(error?: unknown): void {
  client = null;
  config = null;
  for (const section of document.querySelectorAll<HTMLElement>(
    ".authenticated",
  )) {
    section.hidden = true;
  }
  authPanel.hidden = false;
  if (authConfig) {
    renderAuthProviders(authConfig);
  } else {
    externalAuthControls.hidden = true;
  }
  authMessage.textContent = error
    ? "The session ended, but persistent cache removal failed."
    : "";
  setStatus(
    error ? "Local cache purge failed" : "Sign in required",
    error ? "error" : "ready",
  );
}

function renderAuthProviders(auth: AuthConfig): void {
  const providers = externalProviderIds(auth);
  authProvider.replaceChildren(
    ...providers.map((provider) => {
      const option = document.createElement("option");
      option.value = provider;
      option.textContent = provider;
      return option;
    }),
  );
  const available = providers.length > 0;
  externalAuthControls.hidden = !available;
  devLogin.hidden = !auth.developmentIdentity;
  authMessage.textContent = available
    ? "Obtain an API access token through the host application's OIDC flow."
    : auth.developmentIdentity
      ? "Use the loopback-only development identity."
      : "No external identity provider is configured.";
}

function externalProviderIds(
  auth: AuthConfig | null,
): string[] {
  return (auth?.oidcProviders ?? []).filter(
    (provider) => provider !== "dev",
  );
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

async function requestPersistentStorage(): Promise<boolean> {
  const request = navigator.storage?.persist?.();
  if (!request) {
    return false;
  }
  return Promise.race([
    request.catch(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), 500),
    ),
  ]);
}
