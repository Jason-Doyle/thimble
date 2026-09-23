import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

const root = path.resolve(".thimble-e2e");
const issuer = "http://127.0.0.1:8790";
const audience = "thimbledb-e2e";
await rm(root, {
  recursive: true,
  force: true,
});

const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "e2e-key";
publicJwk.alg = "RS256";
const identityProvider = createServer((request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  if (url.pathname === "/jwks") {
    sendJson(response, { keys: [publicJwk] });
    return;
  }
  if (url.pathname === "/token") {
    const subject = url.searchParams.get("subject") ?? "e2e-user";
    void new SignJWT({
      scp: "thimble.access",
      roles: ["thimble.tenant.writer"],
      tid: "tenant-e2e",
    })
      .setProtectedHeader({ alg: "RS256", kid: "e2e-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey)
      .then((token) => {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(token);
      })
      .catch((error) => {
        console.error(error);
        response.writeHead(500).end();
      });
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((resolve, reject) => {
  identityProvider.once("error", reject);
  identityProvider.listen(8790, "127.0.0.1", resolve);
});

const childEnvironment = { ...process.env };
for (const name of [
  "AWS_ACCESS_KEY_ID",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_AUTH_STORAGE_CONTAINER",
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_CONTAINER",
  "ENTRA_AUDIENCE",
  "ENTRA_REQUIRED_ROLE",
  "ENTRA_REQUIRED_SCOPE",
  "ENTRA_TENANT_ID",
  "OIDC_ALLOWED_TENANTS",
  "OIDC_AUDIENCE",
  "OIDC_ISSUER",
  "OIDC_JWKS_URI",
  "OIDC_PROVIDER_ID",
  "OIDC_REQUIRED_ROLE",
  "OIDC_REQUIRED_SCOPE",
  "R2_ACCESS_KEY_ID",
  "R2_ACCOUNT_ID",
  "R2_AUTH_BUCKET",
  "R2_BUCKET",
  "R2_SECRET_ACCESS_KEY",
  "S3_AUTH_BUCKET",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  "THIMBLE_DISABLE_IP_RATE_LIMIT",
  "THIMBLE_MASTER_KEY",
  "THIMBLE_TRUSTED_PROXY_IPS",
]) {
  delete childEnvironment[name];
}
Object.assign(childEnvironment, {
  THIMBLE_PROVIDER: "local",
  THIMBLE_HOST: "127.0.0.1",
  THIMBLE_PORT: "8787",
  THIMBLE_ALLOWED_ORIGIN: "http://127.0.0.1:5173",
  THIMBLE_SECURE_COOKIES: "false",
  THIMBLE_PREFIX: "e2e",
  THIMBLE_KEY_VERSION: "1",
  THIMBLE_READ_KEY_VERSIONS: "",
  THIMBLE_HEAD_TTL_MS: "0",
  THIMBLE_AUTH_RATE_LIMIT: "100",
  THIMBLE_AUTH_RATE_WINDOW_MS: "60000",
  THIMBLE_SESSION_TTL_SECONDS: "3600",
  THIMBLE_SCOPE_CACHE_MAX: "100",
  THIMBLE_SCOPE_CACHE_TTL_MS: "900000",
  THIMBLE_LOCAL_DATA_ROOT: path.join(root, "data"),
  THIMBLE_LOCAL_AUTH_ROOT: path.join(root, "auth"),
  THIMBLE_LOCAL_SECRET_ROOT: path.join(root, "secrets"),
  OIDC_PROVIDER_ID: "e2e",
  OIDC_ISSUER: issuer,
  OIDC_AUDIENCE: audience,
  OIDC_JWKS_URI: `${issuer}/jwks`,
  OIDC_REQUIRED_SCOPE: "thimble.access",
});

const child = spawn("npm run dev", {
  shell: true,
  stdio: "inherit",
  env: childEnvironment,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
    identityProvider.close();
  });
}

child.on("exit", (code) => {
  identityProvider.close(() => process.exit(code ?? 0));
});

function sendJson(
  response: import("node:http").ServerResponse,
  value: unknown,
): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}
