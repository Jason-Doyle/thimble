import type { IncomingMessage } from "node:http";

export function nodeClientIp(request: IncomingMessage): string | null {
  if (process.env.THIMBLE_DISABLE_IP_RATE_LIMIT === "true") {
    return null;
  }
  const remote = normaliseIp(
    request.socket.remoteAddress ?? "unknown",
  );
  if (
    process.env.AWS_LAMBDA_FUNCTION_NAME &&
    isLoopback(remote)
  ) {
    return lambdaSourceIp(request.headers["x-amzn-request-context"]);
  }

  const trustedProxies = new Set(
    (process.env.THIMBLE_TRUSTED_PROXY_IPS ?? "")
      .split(",")
      .map((value) => normaliseIp(value.trim()))
      .filter(Boolean),
  );
  if (trustedProxies.has(remote)) {
    const forwarded = headerValue(
      request.headers["x-forwarded-for"],
    );
    return forwardedClient(forwarded, trustedProxies);
  }
  return remote === "unknown" ? null : remote;
}

function forwardedClient(
  value: string | null,
  trustedProxies: ReadonlySet<string>,
): string | null {
  if (!value) {
    return null;
  }
  const chain = value
    .split(",")
    .map((candidate) => normaliseIp(candidate.trim()))
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate && !trustedProxies.has(candidate)) {
      return candidate;
    }
  }
  return chain[0] ?? null;
}

function lambdaSourceIp(
  value: string | string[] | undefined,
): string | null {
  const context = headerValue(value);
  if (!context) {
    return null;
  }
  try {
    const parsed = JSON.parse(context) as {
      http?: { sourceIp?: unknown };
      identity?: { sourceIp?: unknown };
    };
    const sourceIp =
      parsed.http?.sourceIp ?? parsed.identity?.sourceIp;
    return typeof sourceIp === "string"
      ? normaliseIp(sourceIp)
      : null;
  } catch {
    return null;
  }
}

function headerValue(
  value: string | string[] | undefined,
): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normaliseIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function isLoopback(value: string): boolean {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "localhost"
  );
}
