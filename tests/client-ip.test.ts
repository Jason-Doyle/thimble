import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { nodeClientIp } from "../src/client-ip.js";

describe("nodeClientIp", () => {
  const originalLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const originalProxies = process.env.THIMBLE_TRUSTED_PROXY_IPS;
  const originalDisabled =
    process.env.THIMBLE_DISABLE_IP_RATE_LIMIT;

  afterEach(() => {
    restore("AWS_LAMBDA_FUNCTION_NAME", originalLambda);
    restore("THIMBLE_TRUSTED_PROXY_IPS", originalProxies);
    restore(
      "THIMBLE_DISABLE_IP_RATE_LIMIT",
      originalDisabled,
    );
  });

  it("ignores spoofed forwarding headers from direct clients", () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.THIMBLE_TRUSTED_PROXY_IPS;
    expect(
      nodeClientIp(
        request("203.0.113.10", {
          "x-forwarded-for": "198.51.100.25",
        }),
      ),
    ).toBe("203.0.113.10");
  });

  it("uses the Lambda Web Adapter request context from loopback", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "thimbledb";
    expect(
      nodeClientIp(
        request("127.0.0.1", {
          "x-amzn-request-context": JSON.stringify({
            http: { sourceIp: "198.51.100.42" },
          }),
          "x-forwarded-for": "203.0.113.99",
        }),
      ),
    ).toBe("198.51.100.42");
  });

  it("uses forwarding headers only from configured trusted peers", () => {
    process.env.THIMBLE_TRUSTED_PROXY_IPS = "10.0.0.1";
    expect(
      nodeClientIp(
        request("10.0.0.1", {
          "x-forwarded-for": "198.51.100.7, 10.0.0.1",
        }),
      ),
    ).toBe("198.51.100.7");
  });

  it("walks trusted forwarding chains from right to left", () => {
    process.env.THIMBLE_TRUSTED_PROXY_IPS =
      "10.0.0.1,10.0.0.2";
    expect(
      nodeClientIp(
        request("10.0.0.2", {
          "x-forwarded-for":
            "203.0.113.200, 198.51.100.8, 10.0.0.1",
        }),
      ),
    ).toBe("198.51.100.8");
  });

  it("can disable source-IP limits behind an unverified proxy", () => {
    process.env.THIMBLE_DISABLE_IP_RATE_LIMIT = "true";
    expect(
      nodeClientIp(
        request("10.0.0.1", {
          "x-forwarded-for": "198.51.100.8",
        }),
      ),
    ).toBeNull();
  });
});

function request(
  remoteAddress: string,
  headers: Record<string, string>,
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
