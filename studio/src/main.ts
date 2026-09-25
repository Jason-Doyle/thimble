import {
  createThimbleConnection,
  IndexedDbObjectCache,
  ThimbleConnectionError,
  type JsonDocument,
  type JsonValue,
  type ThimbleClient,
  type ThimbleConnection,
  type ThimbleQuery,
} from "../../src/index.js";
import "./styles.css";

type AuthConfig = {
  oidcProviders: string[];
  developmentIdentity?: boolean;
};

type StudioScope = {
  id: string;
  permissions: Array<"read" | "write" | "admin">;
};

type StudioSession = {
  version: 1;
  provider: string;
  maintenanceMode: boolean;
  layoutGeneration: string;
  user: {
    id: string;
    provider: string;
    roles: string[];
    tenants: string[];
  };
  scopes: StudioScope[];
  isAdministrator: boolean;
};

type StudioIndex = {
  definition: {
    name: string;
    fields: string[];
    mode: "equality" | "range";
    include?: string[];
  };
  active: boolean;
  entries: number | null;
  status:
    | "active"
    | "ready"
    | "empty"
    | "missing"
    | "mismatch"
    | "unknown"
    | "oversized";
};

type StudioCollection = {
  name: string;
  layout: "trie" | "snapshot";
  revision: number;
  hasData: boolean;
  indexes: StudioIndex[];
  unexpectedIndexes: string[];
  retiredLayouts: Array<"trie" | "snapshot">;
};

type DeletedDocument = {
  id: string;
  deletedAt: string;
  restoreUntil: string;
  purgeAfter: string;
  document: JsonDocument;
};

type AuditEntry = {
  at: string;
  action: string;
  scopeId: string | null;
  collection: string | null;
  outcome: "success" | "failure";
  detail: JsonValue;
};

type EditorContext = {
  scopeId: string;
  collection: string;
  selectionVersion: number;
  originalId: string | null;
};

let session: StudioSession | null = null;
let connection: ThimbleConnection | null = null;
let sessionConnection: ThimbleConnection | null = null;
let client: ThimbleClient | null = null;
let collections: StudioCollection[] = [];
let selectedScope: StudioScope | null = null;
let selectedCollection: StudioCollection | null = null;
let editorContext: EditorContext | null = null;
let writesUnlocked = false;
let scopeSelectionVersion = 0;
let collectionSelectionVersion = 0;
let explicitLogoutInProgress = false;
const openedConnections = new Set<ThimbleConnection>();
const auditEntries: AuditEntry[] = [];
let actionQueue = Promise.resolve();

const authView = element<HTMLElement>("auth-view");
const studioView = element<HTMLElement>("studio-view");
const authControls = element<HTMLElement>("auth-controls");
const authProvider = element<HTMLSelectElement>("auth-provider");
const authToken = element<HTMLTextAreaElement>("auth-token");
const authMessage = element<HTMLParagraphElement>("auth-message");
const devLogin = element<HTMLButtonElement>("dev-login");
const scopeSelect = element<HTMLSelectElement>("scope");
const scopePermissions =
  element<HTMLElement>("scope-permissions");
const collectionList = element<HTMLElement>("collections");
const collectionEyebrow =
  element<HTMLElement>("collection-eyebrow");
const collectionTitle =
  element<HTMLHeadingElement>("collection-title");
const collectionFacts =
  element<HTMLElement>("collection-facts");
const modeBadge = element<HTMLElement>("mode-badge");
const writeToggle =
  element<HTMLButtonElement>("write-toggle");
const logoutButton = element<HTMLButtonElement>("logout");
const documentStatus =
  element<HTMLParagraphElement>("document-status");
const documentsOutput = element<HTMLElement>("documents");
const queryPlan = element<HTMLElement>("query-plan");
const queryAst = element<HTMLTextAreaElement>("query-ast");
const editor = element<HTMLElement>("editor");
const editorTitle = element<HTMLHeadingElement>("editor-title");
const documentJson =
  element<HTMLTextAreaElement>("document-json");
const deleteDocumentButton =
  element<HTMLButtonElement>("delete-document");
const indexesOutput = element<HTMLElement>("indexes");
const deletedOutput =
  element<HTMLElement>("deleted-documents");
const operationState =
  element<HTMLElement>("operation-state");
const auditOutput = element<HTMLPreElement>("audit-log");

function bindEvents(): void {
  element<HTMLButtonElement>("auth-login").addEventListener(
    "click",
    () => runAction("oidc-login", authenticateExternal),
  );
  devLogin.addEventListener("click", () =>
    runAction("development-login", authenticateDevelopment),
  );
  logoutButton.addEventListener("click", () =>
    runAction("logout", logout),
  );
  writeToggle.addEventListener("click", () =>
    runAction("toggle-writes", async () => toggleWrites()),
  );
  scopeSelect.addEventListener("change", () =>
    runAction("select-scope", () =>
      selectScope(scopeSelect.value),
    ),
  );
  element<HTMLButtonElement>(
    "refresh-collections",
  ).addEventListener("click", () =>
    runAction("refresh-collections", refreshCollections),
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
    .forEach((button) => {
      button.addEventListener("click", () =>
        activateTab(button.dataset.tab ?? "browse"),
      );
    });
  element<HTMLFormElement>("query-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      void runAction("query", runFormQuery);
    },
  );
  element<HTMLButtonElement>("run-ast").addEventListener(
    "click",
    () => runAction("query-ast", runAstQuery),
  );
  element<HTMLButtonElement>("new-document").addEventListener(
    "click",
    () => runAction("new-document", async () => newDocument()),
  );
  element<HTMLButtonElement>("close-editor").addEventListener(
    "click",
    closeEditor,
  );
  element<HTMLButtonElement>("save-document").addEventListener(
    "click",
    () => runAction("save-document", saveDocument),
  );
  deleteDocumentButton.addEventListener("click", () =>
    runAction("delete-document", deleteDocument),
  );
  element<HTMLButtonElement>(
    "refresh-deleted",
  ).addEventListener("click", () =>
    runAction("list-deleted", loadDeletedDocuments),
  );
  element<HTMLButtonElement>(
    "rebuild-indexes",
  ).addEventListener("click", () =>
    runAction("rebuild-indexes", rebuildIndexes),
  );
  element<HTMLButtonElement>(
    "export-collection",
  ).addEventListener("click", () =>
    runAction("export-collection", exportCollection),
  );
  element<HTMLButtonElement>(
    "purge-deleted",
  ).addEventListener("click", () =>
    runAction("purge-deleted", purgeDeleted),
  );
  element<HTMLButtonElement>(
    "download-audit",
  ).addEventListener("click", downloadAudit);
}

function addPendingStudioCache(namespace: string): void {
  const current = pendingStudioCaches();
  current.add(namespace);
  localStorage.setItem(
    PENDING_CACHE_CLEANUP_KEY,
    JSON.stringify([...current].sort()),
  );
}

function removePendingStudioCache(namespace: string): void {
  const current = pendingStudioCaches();
  current.delete(namespace);
  if (current.size === 0) {
    localStorage.removeItem(PENDING_CACHE_CLEANUP_KEY);
  } else {
    localStorage.setItem(
      PENDING_CACHE_CLEANUP_KEY,
      JSON.stringify([...current].sort()),
    );
  }
}

function pendingStudioCaches(): Set<string> {
  const encoded = localStorage.getItem(
    PENDING_CACHE_CLEANUP_KEY,
  );
  if (!encoded) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return Array.isArray(parsed)
      ? new Set(
          parsed.filter(
            (value): value is string =>
              typeof value === "string",
          ),
        )
      : new Set();
  } catch {
    return new Set();
  }
}

async function bootstrap(): Promise<void> {
  await cleanupPendingStudioCaches();
  try {
    session = await fetchJson<StudioSession>("/api/studio");
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === 401
    ) {
      await renderAuthentication();
      return;
    }

    if (
      error instanceof HttpError &&
      error.status === 404
    ) {
      authMessage.textContent =
        "ThimbleDB Studio is not enabled on this authority.";
      return;
    }
    throw error;
  }
  authView.hidden = true;
  logoutButton.hidden = false;
  writeToggle.hidden = false;
  renderMode();
  renderScopes();
  const first = session.scopes[0];
  if (first) {
    await selectScope(first.id);
  } else {
    documentStatus.textContent =
      "This identity has no readable scopes.";
  }
  studioView.hidden = false;
}

async function renderAuthentication(): Promise<void> {
  const config = await fetchJson<AuthConfig>("/api/auth/config");
  authProvider.replaceChildren(
    ...config.oidcProviders.map((provider) => {
      const option = document.createElement("option");
      option.value = provider;
      option.textContent = provider;
      return option;
    }),
  );
  authControls.hidden = config.oidcProviders.length === 0;
  devLogin.hidden = !config.developmentIdentity;
  authMessage.textContent =
    config.oidcProviders.length > 0
      ? "Use a short-lived API access token from the configured identity provider."
      : config.developmentIdentity
        ? "Use the loopback-only development identity."
        : "No identity provider is configured.";
}

async function authenticateExternal(): Promise<void> {
  const provider = authProvider.value;
  const token = authToken.value.trim();
  if (!provider || !token) {
    throw new Error(
      "Select a provider and supply an API access token",
    );
  }
  await fetchJson(
    `/api/auth/oidc/${encodeURIComponent(provider)}/session`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    },
  );
  authToken.value = "";
  window.location.reload();
}

async function authenticateDevelopment(): Promise<void> {
  await fetchJson("/api/auth/dev/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: "{}",
  });
  window.location.reload();
}

async function logout(): Promise<void> {
  explicitLogoutInProgress = true;
  persistPendingStudioCaches();
  let serverFailure: unknown;
  let serverLoggedOut = false;
  try {
    if (sessionConnection) {
      await fetchJson("/api/auth/logout", {
        method: "POST",
        headers: logoutHeaders(sessionConnection),
        body: "{}",
      });
      serverLoggedOut = true;
    }
  } catch (error) {
    serverFailure = error;
  }
  if (serverLoggedOut) {
    transitionSignedOut(
      "The server session is revoked. Finishing local cache cleanup.",
    );
  }
  try {
    const opened = [...openedConnections];
    const cleanup = await Promise.allSettled(
      opened.map((item) =>
        item.client.logout(),
      ),
    );
    openedConnections.clear();
    let localFailure: PromiseRejectedResult | undefined;
    cleanup.forEach((result, index) => {
      if (result.status === "rejected") {
        openedConnections.add(opened[index]!);
        localFailure ??= result;
      }
    });
    if (!localFailure) {
      try {
        await cleanupPendingStudioCaches();
      } catch (error) {
        localFailure = {
          status: "rejected",
          reason: error,
        };
      }
    }
    if (serverLoggedOut) {
      window.location.reload();
      return;
    }
    if (serverFailure) {
      throw serverFailure;
    }
    if (localFailure) {
      throw localFailure.reason;
    }
  } finally {
    explicitLogoutInProgress = false;
  }

}

const PENDING_CACHE_CLEANUP_KEY =
  "thimbledb-studio-pending-cache-cleanup";

function persistPendingStudioCaches(): void {
  if (!session) {
    return;
  }
  const pending = pendingStudioCaches();
  session.scopes.forEach((scope) =>
    pending.add(
      studioCacheNamespace(session!.provider, scope.id),
    ),
  );
  localStorage.setItem(
    PENDING_CACHE_CLEANUP_KEY,
    JSON.stringify([...pending].sort()),
  );
}

async function cleanupPendingStudioCaches(): Promise<void> {
  const encoded = localStorage.getItem(
    PENDING_CACHE_CLEANUP_KEY,
  );
  if (!encoded) {
    return;
  }
  const namespaces = JSON.parse(encoded) as unknown;
  if (
    !Array.isArray(namespaces) ||
    !namespaces.every(
      (namespace) => typeof namespace === "string",
    )
  ) {
    localStorage.removeItem(PENDING_CACHE_CLEANUP_KEY);
    throw new Error("Studio cache cleanup state is malformed");
  }
  for (const namespace of namespaces) {
    await new IndexedDbObjectCache(namespace).destroy();
    removePendingStudioCache(namespace);
  }
}

function studioCacheNamespace(
  provider: string,
  scopeId: string,
): string {
  const readUrl = new URL("/api/objects", window.location.href);
  return [
    provider,
    readUrl.origin,
    readUrl.pathname,
    scopeId,
  ].join(":");
}

function transitionSignedOut(message: string): void {
  session = null;
  connection = null;
  sessionConnection = null;
  client = null;
  selectedScope = null;
  selectedCollection = null;
  writesUnlocked = false;
  clearCollectionViews();
  scopeSelect.replaceChildren();
  scopePermissions.replaceChildren();
  studioView.hidden = true;
  authView.hidden = false;
  writeToggle.hidden = true;
  logoutButton.hidden = true;
  authMessage.textContent = message;
  modeBadge.textContent = "Disconnected";
  modeBadge.className = "badge muted";
}

function transitionDisconnected(message: string): void {
  selectedScope = null;
  selectedCollection = null;
  connection = null;
  client = null;
  writesUnlocked = false;
  clearCollectionViews();
  scopePermissions.replaceChildren();
  documentStatus.textContent = message;
  renderMode();
}

function renderScopes(): void {
  if (!session) {
    return;
  }
  scopeSelect.replaceChildren(
    ...session.scopes.map((scope) => {
      const option = document.createElement("option");
      option.value = scope.id;
      option.textContent = scope.id;
      return option;
    }),
  );
}

async function selectScope(scopeId: string): Promise<void> {
  if (!session) {
    return;
  }
  const scope =
    session.scopes.find((candidate) => candidate.id === scopeId) ??
    null;
  if (!scope) {
    throw new Error("The selected scope is not granted");
  }
  const previousConnection = connection;
  const previousScopeId = selectedScope?.id ?? null;
  const selectionVersion = ++scopeSelectionVersion;
  collectionSelectionVersion += 1;
  selectedScope = null;
  selectedCollection = null;
  collections = [];
  writesUnlocked = false;
  connection = null;
  client = null;
  clearCollectionViews();
  scopePermissions.replaceChildren();
  renderMode();
  if (previousConnection) {
    try {
      await previousConnection.client.dispose();
      openedConnections.delete(previousConnection);
    } catch (error) {
      if (previousScopeId) {
        scopeSelect.value = previousScopeId;
      }
      throw error;
    }
  }
  selectedScope = scope;
  scopeSelect.value = scope.id;
  scopePermissions.replaceChildren(
    ...scope.permissions.map((permission) => {
      const badge = document.createElement("span");
      badge.textContent = permission;
      return badge;
    }),
  );
  let nextConnection: ThimbleConnection;
  try {
    nextConnection = await createThimbleConnection({
      configurationUrl:
        `/api/config?scope=${encodeURIComponent(scope.id)}`,
      onLogout: (error) => {
        if (scopeSelectionVersion === selectionVersion) {
          if (error) {
            transitionDisconnected(
              `Local cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          } else if (!explicitLogoutInProgress) {
            window.location.reload();
          }
        }
      },
      onLayoutChange: () => {
        if (scopeSelectionVersion === selectionVersion) {
          window.location.reload();
        }
      },
    });
  } catch (error) {
    if (
      error instanceof ThimbleConnectionError &&
      (error.status === 401 || error.status === 403)
    ) {
      const namespace = studioCacheNamespace(
        session.provider,
        scope.id,
      );
      addPendingStudioCache(namespace);
      let cleanupFailure: unknown;
      try {
        await new IndexedDbObjectCache(namespace).destroy();
        removePendingStudioCache(namespace);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      } finally {
        if (error.status === 401) {
          transitionSignedOut(
            cleanupFailure
              ? "The authority rejected the session. Local cache cleanup will retry on the next Studio load."
              : "The authority rejected the session. Local scope cache was removed.",
          );
        } else {
          transitionDisconnected(
            cleanupFailure
              ? "Scope authorization was rejected and local cache cleanup will retry."
              : "Scope authorization was rejected.",
          );
        }
      }
      if (cleanupFailure) {
        throw new Error(
          `Authority rejected the scope and local cache cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  if (
    scopeSelectionVersion !== selectionVersion ||
    selectedScope.id !== scope.id
  ) {
    await nextConnection.client.dispose();
    return;
  }
  openedConnections.add(nextConnection);
  connection = nextConnection;
  sessionConnection = nextConnection;
  client = nextConnection.client;
  renderMode();
  await refreshCollections(selectionVersion);
}

async function refreshCollections(
  expectedScopeVersion = scopeSelectionVersion,
): Promise<void> {
  const scope = requireScope();
  const loaded: StudioCollection[] = [];
  let offset = 0;
  while (true) {
    const response = await fetchJson<{
      scopeId: string;
      collections: StudioCollection[];
      nextOffset: number | null;
    }>(
      `/api/studio/scopes/${encodeURIComponent(scope.id)}/collections?offset=${offset}&limit=20`,
    );
    if (
      scopeSelectionVersion !== expectedScopeVersion ||
      selectedScope?.id !== scope.id
    ) {
      return;
    }
    loaded.push(...response.collections);
    if (response.nextOffset === null) {
      break;
    }
    offset = response.nextOffset;
  }
  collections = loaded;
  collectionList.replaceChildren(
    ...collections.map((collection) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = collection.name;
      button.classList.toggle(
        "active",
        collection.name === selectedCollection?.name,
      );
      button.addEventListener("click", () =>
        runAction("select-collection", () =>
          selectCollection(collection.name),
        ),
      );
      return button;
    }),
  );
  if (selectedCollection) {
    selectedCollection =
      collections.find(
        (collection) =>
          collection.name === selectedCollection?.name,
      ) ?? null;
  }
  if (!selectedCollection && collections[0]) {
    await selectCollection(collections[0].name);
  } else {
    renderCollection();
    if (selectedCollection) {
      await loadIndexHealth(collectionSelectionVersion);
    }
  }
}

async function selectCollection(name: string): Promise<void> {
  const selectionVersion = ++collectionSelectionVersion;
  clearCollectionDataViews();
  selectedCollection =
    collections.find((collection) => collection.name === name) ??
    null;
  closeEditor();
  renderCollection();
  await loadIndexHealth(selectionVersion);
  await runFormQuery(selectionVersion);
}

function renderCollection(): void {
  collectionList
    .querySelectorAll("button")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.textContent === selectedCollection?.name,
      ),
    );
  if (!selectedCollection || !selectedScope) {
    collectionEyebrow.textContent = "Select a collection";
    collectionTitle.textContent = "Studio";
    collectionFacts.replaceChildren();
    return;
  }
  collectionEyebrow.textContent = selectedScope.id;
  collectionTitle.textContent = selectedCollection.name;
  const facts = [
    selectedCollection.layout,
    `revision ${selectedCollection.revision}`,
    selectedCollection.hasData ? "data present" : "empty",
  ];
  collectionFacts.replaceChildren(
    ...facts.map((fact) => {
      const value = document.createElement("span");
      value.textContent = fact;
      return value;
    }),
  );
  renderIndexes();
  renderOperationState();
}

async function runFormQuery(
  expectedCollectionVersion = collectionSelectionVersion,
): Promise<void> {
  const query = formQuery();
  queryAst.value = JSON.stringify(query, null, 2);
  await executeQuery(query, expectedCollectionVersion);
}

async function runAstQuery(): Promise<void> {
  const query = JSON.parse(
    queryAst.value,
  ) as ThimbleQuery<JsonDocument>;
  await executeQuery(query, collectionSelectionVersion);
}

async function executeQuery(
  query: ThimbleQuery<JsonDocument>,
  expectedCollectionVersion: number,
): Promise<void> {
  const collection = requireCollection();
  const scope = requireScope();
  const result = await requireClient()
    .collection<JsonDocument>(collection.name)
    .query(query);
  if (
    collectionSelectionVersion !== expectedCollectionVersion ||
    selectedCollection?.name !== collection.name ||
    selectedScope?.id !== scope.id
  ) {
    return;
  }
  queryPlan.hidden = false;
  queryPlan.textContent =
    `Plan: ${result.plan}` +
    (result.indexName ? ` (${result.indexName})` : "") +
    ` · candidates scanned: ${result.scannedDocuments}`;
  documentStatus.textContent =
    `${result.documents.length} documents returned.`;
  renderDocuments(result.documents);
}

function formQuery(): ThimbleQuery<JsonDocument> {
  const field =
    element<HTMLInputElement>("query-field").value.trim();
  const orderField =
    element<HTMLInputElement>(
      "query-order-field",
    ).value.trim();
  const query: ThimbleQuery<JsonDocument> = {
    version: 1,
    limit: integerValue("query-limit"),
    maxScanDocuments: integerValue("query-max-scan"),
  };
  if (field) {
    query.where = {
      field,
      operator: element<HTMLSelectElement>(
        "query-operator",
      ).value as
        | "eq"
        | "ne"
        | "lt"
        | "lte"
        | "gt"
        | "gte"
        | "in"
        | "contains",
      value: queryValue(
        element<HTMLInputElement>("query-value").value,
      ),
    };
  }
  if (orderField) {
    query.orderBy = [
      {
        field: orderField,
        direction: element<HTMLSelectElement>(
          "query-direction",
        ).value as "asc" | "desc",
      },
    ];
  }
  return query;
}

function queryValue(input: string): JsonValue {
  const value = input.trim();
  if (!value) {
    return "";
  }
  if (
    value === "true" ||
    value === "false" ||
    value === "null" ||
    /^-?\d+(?:\.\d+)?$/.test(value) ||
    value.startsWith("[") ||
    value.startsWith("{") ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return JSON.parse(value) as JsonValue;
  }
  return value;
}

function renderDocuments(documents: JsonDocument[]): void {
  const scope = requireScope();
  const collection = requireCollection();
  const selectionVersion = collectionSelectionVersion;
  documentsOutput.replaceChildren(
    ...documents.map((documentValue) => {
      const article = document.createElement("article");
      article.className = "document-card";
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = documentValue.id;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary";
      edit.textContent = "Open";
      edit.addEventListener("click", () => {
        if (
          selectedScope?.id !== scope.id ||
          selectedCollection?.name !== collection.name ||
          collectionSelectionVersion !== selectionVersion
        ) {
          return;
        }
        openEditor(
          documentValue,
          scope.id,
          collection.name,
          selectionVersion,
        );
      });
      header.append(title, edit);
      const json = document.createElement("pre");
      json.textContent = JSON.stringify(documentValue, null, 2);
      article.append(header, json);
      return article;
    }),
  );
}

function newDocument(): void {
  requireWritesUnlocked();
  const scope = requireScope();
  const collection = requireCollection();
  editorContext = {
    scopeId: scope.id,
    collection: collection.name,
    selectionVersion: collectionSelectionVersion,
    originalId: null,
  };
  documentJson.value = JSON.stringify({
    id: crypto.randomUUID(),
  }, null, 2);
  editorTitle.textContent = "Create document";
  deleteDocumentButton.hidden = true;
  editor.hidden = false;
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function openEditor(
  documentValue: JsonDocument,
  scopeId = requireScope().id,
  collection = requireCollection().name,
  selectionVersion = collectionSelectionVersion,
): void {
  editorContext = {
    scopeId,
    collection,
    selectionVersion,
    originalId: documentValue.id,
  };
  documentJson.value = JSON.stringify(documentValue, null, 2);
  editorTitle.textContent = `Document ${documentValue.id}`;
  deleteDocumentButton.hidden = false;
  editor.hidden = false;
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeEditor(): void {
  editorContext = null;
  documentJson.value = "";
  editor.hidden = true;
}

async function saveDocument(): Promise<void> {
  requireWritesUnlocked();
  const context = requireEditorContext();
  requireCurrentEditorSelection(context);
  const documentValue = JSON.parse(
    documentJson.value,
  ) as JsonDocument;
  if (
    typeof documentValue !== "object" ||
    documentValue === null ||
    Array.isArray(documentValue) ||
    typeof documentValue.id !== "string" ||
    !documentValue.id
  ) {
    throw new Error("Document JSON requires a non-empty string id");
  }
  if (
    context.originalId &&
    context.originalId !== documentValue.id
  ) {
    throw new Error("Document IDs cannot be changed in the editor");
  }
  if (
    !window.confirm(
      `Write document ${documentValue.id} in ${context.scopeId}/${context.collection}?`,
    )
  ) {
    return;
  }
  await requireClient()
    .collection<JsonDocument>(context.collection)
    .put(documentValue);
  recordAudit("save-document", "success", {
    id: documentValue.id,
  });
  closeEditor();
  await runFormQuery();
  await refreshCollections();
}

async function deleteDocument(): Promise<void> {
  requireWritesUnlocked();
  const context = requireEditorContext();
  requireCurrentEditorSelection(context);
  if (!context.originalId) {
    throw new Error("The new document has not been saved");
  }
  const id = context.originalId;
  if (
    !window.confirm(
      `Delete document ${id}? It will remain restorable during the configured retention window.`,
    )
  ) {
    return;
  }
  await requireClient()
    .collection<JsonDocument>(context.collection)
    .delete(id);
  recordAudit("delete-document", "success", { id });
  closeEditor();
  await runFormQuery();
}

async function loadDeletedDocuments(): Promise<void> {
  const scope = requireScope();
  const collection = requireCollection();
  const selectionVersion = collectionSelectionVersion;
  const response = await fetchJson<{
    deleted: DeletedDocument[];
  }>(
    `/api/studio/scopes/${encodeURIComponent(scope.id)}/collections/${encodeURIComponent(collection.name)}/deleted`,
  );
  if (
    collectionSelectionVersion !== selectionVersion ||
    selectedCollection?.name !== collection.name ||
    selectedScope?.id !== scope.id
  ) {
    return;
  }
  deletedOutput.replaceChildren(
    ...response.deleted.map((deleted) => {
      const article = document.createElement("article");
      article.className = "document-card";
      const title = document.createElement("h3");
      title.textContent = deleted.id;
      const detail = document.createElement("p");
      detail.textContent =
        `Restore until ${new Date(deleted.restoreUntil).toLocaleString()}`;
      const json = document.createElement("pre");
      json.textContent = JSON.stringify(deleted.document, null, 2);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.disabled = !canWrite() || !writesUnlocked;
      restore.addEventListener("click", () =>
        runAction("restore-document", async () => {
          if (
            selectedScope?.id !== scope.id ||
            selectedCollection?.name !== collection.name
          ) {
            throw new Error(
              "The selected scope or collection changed",
            );
          }
          requireWritesUnlocked();
          if (!window.confirm(`Restore document ${deleted.id}?`)) {
            return;
          }
          await requireClient()
            .collection<JsonDocument>(collection.name)
            .restore(deleted.id);
          recordAudit("restore-document", "success", {
            id: deleted.id,
          });
          await loadDeletedDocuments();
          await runFormQuery();
        }),
      );
      article.append(title, detail, json, restore);
      return article;
    }),
  );
  if (response.deleted.length === 0) {
    deletedOutput.textContent =
      "No retained deletions were found.";
  }
}

function renderIndexes(): void {
  const collection = selectedCollection;
  if (!collection) {
    indexesOutput.textContent = "Select a collection.";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Index</th><th>Mode</th><th>Fields</th><th>Covers</th><th>Status</th><th>Entries</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const index of collection.indexes) {
    const row = document.createElement("tr");
    for (const value of [
      index.definition.name,
      index.definition.mode,
      index.definition.fields.join(", "),
      index.definition.include?.join(", ") ?? "None",
      index.status,
      index.entries === null ? "—" : String(index.entries),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
  for (const name of collection.unexpectedIndexes) {
    const row = document.createElement("tr");
    for (const value of [
      name,
      "unknown",
      "—",
      "unexpected",
      "—",
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  indexesOutput.replaceChildren(table);
  if (
    collection.indexes.length === 0 &&
    collection.unexpectedIndexes.length === 0
  ) {
    indexesOutput.textContent =
      "No secondary indexes are configured.";
  }
}

async function loadIndexHealth(
  expectedCollectionVersion: number,
): Promise<void> {
  const scope = requireScope();
  const collection = requireCollection();
  for (const configured of collection.indexes) {
    const response = await fetchJson<{
      index: StudioIndex;
    }>(
      `/api/studio/scopes/${encodeURIComponent(scope.id)}/collections/${encodeURIComponent(collection.name)}/indexes/${encodeURIComponent(configured.definition.name)}/health`,
    );
    if (
      collectionSelectionVersion !== expectedCollectionVersion ||
      selectedScope?.id !== scope.id ||
      selectedCollection?.name !== collection.name
    ) {
      return;
    }
    const index = collection.indexes.findIndex(
      (candidate) =>
        candidate.definition.name ===
        response.index.definition.name,
    );
    if (index >= 0) {
      collection.indexes[index] = response.index;
      renderIndexes();
    }
  }
}

function clearCollectionViews(): void {
  collectionList.replaceChildren();
  collectionEyebrow.textContent = "Select a collection";
  collectionTitle.textContent = "Studio";
  collectionFacts.replaceChildren();
  documentsOutput.replaceChildren();
  deletedOutput.replaceChildren();
  indexesOutput.replaceChildren();
  queryPlan.hidden = true;
  documentStatus.textContent = "";
  closeEditor();
}

function clearCollectionDataViews(): void {
  documentsOutput.replaceChildren();
  deletedOutput.replaceChildren();
  indexesOutput.replaceChildren();
  queryPlan.hidden = true;
  documentStatus.textContent = "";
  closeEditor();
}

async function rebuildIndexes(): Promise<void> {
  requireMaintenanceAccess();
  const scope = requireScope();
  const collection = requireCollection();
  const selectionVersion = collectionSelectionVersion;
  const confirmation = window.prompt(
    `Type ${collection.name} to apply the configured index set while the authority is in maintenance mode.`,
  );
  if (confirmation !== collection.name) {
    return;
  }
  requireCurrentOperationSelection(
    scope.id,
    collection.name,
    selectionVersion,
  );
  const response = await fetchJson<{
    records: number;
    indexes: string[];
  }>(
    `/api/studio/scopes/${encodeURIComponent(scope.id)}/collections/${encodeURIComponent(collection.name)}/rebuild-indexes`,
    {
      method: "POST",
      headers: mutationHeaders(),
      body: "{}",
    },
  );
  recordAudit("rebuild-indexes", "success", {
    records: response.records,
    indexes: response.indexes,
  });
  await connection?.cache.clearAll();
  await refreshCollections();
}

async function exportCollection(): Promise<void> {
  const scope = requireScope();
  const collection = requireCollection();
  const response = await fetch(
    `/api/studio/scopes/${encodeURIComponent(scope.id)}/collections/${encodeURIComponent(collection.name)}/export`,
    {
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const error = await httpError(response);
    await handleStudioHttpError(error);
    throw error;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    `${safeFileName(scope.id)}--${collection.name}.ndjson`;
  link.click();
  URL.revokeObjectURL(url);
  recordAudit("export-collection", "success", {
    records: Number(response.headers.get("x-thimble-records") ?? 0),
    sha256: response.headers.get("x-thimble-sha256") ?? "",
  });
}

async function purgeDeleted(): Promise<void> {
  requireAdministrativeWriteAccess();
  const scope = requireScope();
  const collection = requireCollection();
  const selectionVersion = collectionSelectionVersion;
  const confirmation = window.prompt(
    `Type ${scope.id} to purge expired deletions from ${collection.name}.`,
  );
  if (confirmation !== scope.id) {
    return;
  }
  requireCurrentOperationSelection(
    scope.id,
    collection.name,
    selectionVersion,
  );
  const response = await fetchJson<{
    purged: number;
  }>(
    `/api/studio/scopes/${encodeURIComponent(scope.id)}/collections/${encodeURIComponent(collection.name)}/purge-deleted`,
    {
      method: "POST",
      headers: mutationHeaders(),
      body: "{}",
    },
  );
  recordAudit("purge-deleted", "success", {
    purged: response.purged,
  });
  await connection?.cache.clearAll();
  await loadDeletedDocuments();
}

function activateTab(name: string): void {
  document
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.tab === name,
      ),
    );
  document
    .querySelectorAll<HTMLElement>(".tab-panel")
    .forEach((panel) => {
      panel.hidden = panel.id !== `tab-${name}`;
    });
  if (name === "deleted" && selectedCollection) {
    void runAction("list-deleted", loadDeletedDocuments);
  }
}

function toggleWrites(): void {
  if (writesUnlocked) {
    writesUnlocked = false;
    renderMode();
    return;
  }
  if (!canWrite()) {
    throw new Error(
      "The selected scope does not grant write permission",
    );
  }
  const scope = requireScope();
  const confirmation = window.prompt(
    `Studio starts read-only. Type ${scope.id} to enable writes for this browser session.`,
  );
  if (confirmation !== scope.id) {
    return;
  }
  writesUnlocked = true;
  recordAudit("enable-writes", "success", {
    scopeId: scope.id,
  });
  renderMode();
}

function renderMode(): void {
  if (!session || !selectedScope) {
    modeBadge.textContent = "Disconnected";
    modeBadge.className = "badge muted";
    writeToggle.disabled = true;
    element<HTMLButtonElement>("save-document").disabled = true;
    deleteDocumentButton.disabled = true;
    element<HTMLButtonElement>("new-document").disabled = true;
    element<HTMLButtonElement>("rebuild-indexes").disabled = true;
    element<HTMLButtonElement>("purge-deleted").disabled = true;
    return;
  }
  if (writesUnlocked) {
    modeBadge.textContent = "Writes enabled";
    modeBadge.className = "badge warning";
    writeToggle.textContent = "Return to read-only";
  } else {
    modeBadge.textContent = "Read-only";
    modeBadge.className = "badge";
    writeToggle.textContent = "Enable writes";
  }
  writeToggle.disabled = !canWrite();
  deleteDocumentButton.disabled = !writesUnlocked;
  element<HTMLButtonElement>("save-document").disabled =
    !writesUnlocked;
  element<HTMLButtonElement>("new-document").disabled =
    !writesUnlocked;
  element<HTMLButtonElement>("rebuild-indexes").disabled =
    !canMaintain() || !session.maintenanceMode || !writesUnlocked;
  element<HTMLButtonElement>("purge-deleted").disabled =
    !canMaintain() || !writesUnlocked;
  renderOperationState();
}

function renderOperationState(): void {
  if (!session || !selectedScope) {
    operationState.textContent = "";
    return;
  }
  const messages = [
    `Authority maintenance mode: ${session.maintenanceMode ? "enabled" : "disabled"}.`,
    `Scope permissions: ${selectedScope.permissions.join(", ")}.`,
    session.isAdministrator
      ? "Identity administration role: granted."
      : "Identity administration role: not granted.",
  ];
  operationState.textContent = messages.join(" ");
}

function mutationHeaders(): Record<string, string> {
  if (!connection) {
    throw new Error("Studio is not connected");
  }
  if (connection.config.scope.id !== requireScope().id) {
    throw new Error(
      "The active client does not match the selected scope",
    );
  }
  return {
    "content-type": "application/json",
    "x-thimble-csrf": connection.config.csrfToken,
    "x-thimble-scope": requireScope().id,
    "x-thimble-layout-generation":
      connection.config.layoutGeneration,
  };
}

function logoutHeaders(
  activeConnection: ThimbleConnection,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-thimble-csrf": activeConnection.config.csrfToken,
  };
}

function requireCurrentOperationSelection(
  scopeId: string,
  collection: string,
  selectionVersion: number,
): void {
  if (
    selectedScope?.id !== scopeId ||
    selectedCollection?.name !== collection ||
    collectionSelectionVersion !== selectionVersion ||
    connection?.config.scope.id !== scopeId
  ) {
    throw new Error(
      "The selected scope or collection changed; retry the operation",
    );
  }
}

function canWrite(): boolean {
  return (
    selectedScope?.permissions.includes("write") ?? false
  );
}

function canMaintain(): boolean {
  return Boolean(session?.isAdministrator && canWrite());
}

function requireWritesUnlocked(): void {
  if (!writesUnlocked || !canWrite()) {
    throw new Error(
      "Enable writes for the selected scope before changing data",
    );
  }
}

function requireAdministrativeWriteAccess(): void {
  requireWritesUnlocked();
  if (!session?.isAdministrator) {
    throw new Error(
      "This action requires thimble.admin and explicit scope write access",
    );
  }
}

function requireMaintenanceAccess(): void {
  requireAdministrativeWriteAccess();
  if (!session?.maintenanceMode) {
    throw new Error(
      "Enable authority maintenance mode before rebuilding indexes",
    );
  }
}

function requireScope(): StudioScope {
  if (!selectedScope) {
    throw new Error("Select a scope");
  }
  return selectedScope;
}

function requireCollection(): StudioCollection {
  if (!selectedCollection) {
    throw new Error("Select a collection");
  }
  return selectedCollection;
}

function requireClient(): ThimbleClient {
  if (!client) {
    throw new Error("Studio is not connected");
  }
  return client;
}

function requireEditorContext(): EditorContext {
  if (!editorContext) {
    throw new Error("Open a document before changing it");
  }
  return editorContext;
}

function requireCurrentEditorSelection(
  context: EditorContext,
): void {
  if (
    selectedScope?.id !== context.scopeId ||
    selectedCollection?.name !== context.collection ||
    collectionSelectionVersion !== context.selectionVersion ||
    connection?.config.scope.id !== context.scopeId
  ) {
    throw new Error(
      "The selected scope or collection changed; reopen the document",
    );
  }
}

async function runAction(
  action: string,
  operation: () => Promise<void>,
): Promise<void> {
  const pending = actionQueue.then(operation);
  actionQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  try {
    await pending;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    documentStatus.textContent = message;
    authMessage.textContent = message;
    recordAudit(action, "failure", { message });
  }
}

function recordAudit(
  action: string,
  outcome: AuditEntry["outcome"],
  detail: JsonValue,
): void {
  auditEntries.unshift({
    at: new Date().toISOString(),
    action,
    scopeId: selectedScope?.id ?? null,
    collection: selectedCollection?.name ?? null,
    outcome,
    detail,
  });
  auditOutput.textContent = JSON.stringify(
    auditEntries,
    null,
    2,
  );
}

function downloadAudit(): void {
  const blob = new Blob(
    [`${JSON.stringify(auditEntries, null, 2)}\n`],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "thimbledb-studio-actions.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function fetchJson<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(input, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const error = await httpError(response);
    await handleStudioHttpError(error);
    throw error;
  }
  return response.json() as Promise<T>;
}

async function httpError(response: Response): Promise<HttpError> {
  let message = `Request failed with ${response.status}`;
  let code: string | null = null;
  try {
    const body = (await response.clone().json()) as {
      message?: unknown;
      error?: unknown;
    };
    if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
    if (typeof body.error === "string") {
      code = body.error;
    }
  } catch {
    const text = await response.text();
    if (text) {
      message = text;
    }
  }
  return new HttpError(message, response.status, code);
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function handleStudioHttpError(
  error: HttpError,
): Promise<void> {
  if (error.status === 401) {
    persistPendingStudioCaches();
    explicitLogoutInProgress = true;
    try {
      await Promise.allSettled(
        [...openedConnections].map((opened) =>
          opened.client.logout(),
        ),
      );
      openedConnections.clear();
      transitionSignedOut(
        "The authority rejected the session. Local cache cleanup will continue on the next Studio load if needed.",
      );
    } finally {
      explicitLogoutInProgress = false;
    }
    return;
  }
  if (
    error.status === 403 &&
    error.code === "scope_denied" &&
    selectedScope
  ) {
    const namespace = session
      ? studioCacheNamespace(
          session.provider,
          selectedScope.id,
        )
      : null;
    if (namespace) {
      addPendingStudioCache(namespace);
    }
    try {
      await connection?.client.dispose();
      if (namespace) {
        removePendingStudioCache(namespace);
      }
    } finally {
      transitionDisconnected(
        "The authority removed access to the selected scope.",
      );
    }
  }
}

function integerValue(id: string): number {
  const value = Number(
    element<HTMLInputElement>(id).value,
  );
  if (!Number.isInteger(value)) {
    throw new Error(`${id} must be an integer`);
  }
  return value;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element: ${id}`);
  }
  return value as T;
}

bindEvents();
try {
  await bootstrap();
} catch (error) {
  studioView.hidden = true;
  authView.hidden = false;
  authMessage.textContent =
    error instanceof Error ? error.message : String(error);
}
