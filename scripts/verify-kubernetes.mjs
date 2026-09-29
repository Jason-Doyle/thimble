import {
  spawn,
} from "node:child_process";

const authorityUrl = "http://127.0.0.1:18787";
const oidcUrl = "http://127.0.0.1:18790";
const processes = [
  portForward(
    "service/thimbledb",
    "18787:8787",
  ),
  portForward(
    "service/thimbledb-test-oidc",
    "18790:8080",
  ),
];

try {
  await waitFor(`${authorityUrl}/readyz`);
  await waitFor(`${oidcUrl}/healthz`);

  const health = await json(
    `${authorityUrl}/healthz`,
  );
  assert(
    health.status === "ok",
    "Authority health check failed",
  );
  const ready = await json(
    `${authorityUrl}/readyz`,
  );
  assert(
    ready.status === "ready" &&
      ready.provider === "local",
    "Authority readiness check failed",
  );
  const authConfig = await json(
    `${authorityUrl}/api/auth/config`,
  );
  assert(
    authConfig.oidcProviders?.includes("k8s"),
    "OIDC provider was not advertised",
  );

  const tokenResponse = await fetch(
    `${oidcUrl}/token?subject=helm-smoke`,
  );
  assert(
    tokenResponse.ok,
    "OIDC token request failed",
  );
  const token = await tokenResponse.text();
  const login = await fetch(
    `${authorityUrl}/api/auth/oidc/k8s/session`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: authorityUrl,
      },
      body: "{}",
    },
  );
  assert(login.ok, "Authority login failed");
  const cookie = login.headers
    .get("set-cookie")
    ?.split(";", 1)[0];
  assert(cookie, "Authority login omitted its cookie");

  const config = await requestJson(
    `${authorityUrl}/api/config`,
    {
      headers: {
        cookie,
      },
    },
  );
  assert(
    config.mutationBatchBaseUrl ===
      "/api/mutation-batches",
    "Mutation batching was not advertised",
  );
  assert(
    config.readBundleBaseUrl ===
      "/api/read-bundles",
    "Read bundles were not advertised",
  );
  const mutationHeaders = {
    cookie,
    "content-type": "application/json",
    origin: authorityUrl,
    "x-thimble-csrf": config.csrfToken,
    "x-thimble-layout-generation":
      config.layoutGeneration,
    "x-thimble-scope": config.scope.id,
  };

  const single = await requestJson(
    `${authorityUrl}/api/collections/notes/documents/note-1`,
    {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        id: "note-1",
        title: "Single",
      }),
    },
  );
  assert(
    single.document?.title === "Single",
    "Single write verification failed",
  );

  const batch = await requestJson(
    `${authorityUrl}/api/mutation-batches/notes`,
    {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        version: 1,
        documents: [
          {
            id: "note-2",
            title: "Batch two",
          },
          {
            id: "note-3",
            title: "Batch three",
          },
        ],
      }),
    },
  );
  assert(
    batch.documents?.length === 2 &&
      batch.revision === 2,
    "Mutation batch verification failed",
  );

  const read = await requestJson(
    `${authorityUrl}/api/read-bundles/${encodeURIComponent(config.scope.id)}/notes/note-2`,
    {
      headers: {
        cookie,
      },
    },
  );
  assert(
    read.document?.title === "Batch two",
    "Read bundle verification failed",
  );

  console.log(JSON.stringify({
    health: health.status,
    provider: ready.provider,
    oidc: "k8s",
    revision: batch.revision,
    document: read.document.id,
  }));
} finally {
  for (const process of processes) {
    process.kill();
  }
}

function portForward(resource, ports) {
  const child = spawn(
    "kubectl",
    [
      "--namespace",
      "thimbledb",
      "port-forward",
      resource,
      ports,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  child.stdout.on("data", (chunk) =>
    process.stdout.write(chunk),
  );
  child.stderr.on("data", (chunk) =>
    process.stderr.write(chunk),
  );
  return child;
}

async function waitFor(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The port-forward or pod may still be starting.
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(url) {
  const response = await fetch(url);
  assert(
    response.ok,
    `${url} returned ${response.status}`,
  );
  return response.json();
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert(
    response.ok,
    `${url} returned ${response.status}: ${JSON.stringify(body)}`,
  );
  return body;
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}
