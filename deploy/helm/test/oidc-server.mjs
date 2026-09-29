import {
  createServer,
} from "node:http";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";

const issuer =
  process.env.OIDC_ISSUER ??
  "http://thimbledb-test-oidc.thimbledb.svc.cluster.local:8080";
const audience =
  process.env.OIDC_AUDIENCE ??
  "thimbledb-k8s";
const { privateKey, publicKey } =
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "k8s-test-key",
  use: "sig",
};

createServer((request, response) => {
  const url = new URL(
    request.url ?? "/",
    issuer,
  );
  if (url.pathname === "/healthz") {
    return sendJson(response, {
      status: "ok",
    });
  }
  if (url.pathname === "/jwks") {
    return sendJson(response, {
      keys: [publicJwk],
    });
  }
  if (url.pathname === "/token") {
    const now = Math.floor(Date.now() / 1_000);
    const subject =
      url.searchParams.get("subject") ??
      "k8s-smoke";
    const header = encode({
      alg: "RS256",
      kid: publicJwk.kid,
      typ: "JWT",
    });
    const payload = encode({
      aud: audience,
      exp: now + 3_600,
      iat: now,
      iss: issuer,
      roles: [
        "thimble.user",
        "thimble.admin",
      ],
      scp: "thimble.access",
      sub: subject,
      tid: "k8s-smoke",
    });
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    ).toString("base64url");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type":
        "text/plain; charset=utf-8",
    });
    response.end(
      `${header}.${payload}.${signature}`,
    );
    return;
  }
  response.writeHead(404).end();
}).listen(8080, "0.0.0.0");

function encode(value) {
  return Buffer.from(
    JSON.stringify(value),
  ).toString("base64url");
}

function sendJson(response, value) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type":
      "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}
