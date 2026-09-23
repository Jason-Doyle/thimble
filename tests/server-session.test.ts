import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  DemoSessionAuthorizer,
  UnauthorizedError,
} from "../src/server-session.js";

describe("DemoSessionAuthorizer", () => {
  it("stores only an opaque HttpOnly session id in the cookie", () => {
    const authorizer = new DemoSessionAuthorizer(
      "user-a",
      "test-session-secret",
    );
    const setHeader = vi.fn();
    const request = {
      headers: {},
    } as IncomingMessage;
    const response = {
      setHeader,
    } as unknown as ServerResponse;

    authorizer.ensure(request, response);

    const cookie = String(setHeader.mock.calls[0]?.[1]);
    expect(cookie).toContain("thimble_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("user-a");
  });

  it("authorizes only the granted scope", () => {
    const authorizer = new DemoSessionAuthorizer(
      "user-a",
      "test-session-secret",
    );
    const setHeader = vi.fn();
    authorizer.ensure(
      { headers: {} } as IncomingMessage,
      { setHeader } as unknown as ServerResponse,
    );
    const cookie = String(setHeader.mock.calls[0]?.[1]).split(";")[0];
    const authenticated = {
      headers: { cookie },
    } as IncomingMessage;

    expect(() => authorizer.require(authenticated, "user-a")).not.toThrow();
    expect(() => authorizer.require(authenticated, "user-b")).toThrow(
      UnauthorizedError,
    );
  });

  it("rejects a tampered session cookie", () => {
    const authorizer = new DemoSessionAuthorizer(
      "user-a",
      "test-session-secret",
    );
    const setHeader = vi.fn();
    authorizer.ensure(
      { headers: {} } as IncomingMessage,
      { setHeader } as unknown as ServerResponse,
    );
    const original = String(setHeader.mock.calls[0]?.[1])
      .split(";")[0]!;
    const [nameAndPayload, signature] = original.split(".");
    const replacement = signature?.startsWith("a") ? "b" : "a";
    const cookie = `${nameAndPayload}.${replacement}${signature?.slice(1) ?? ""}`;
    const request = {
      headers: { cookie },
    } as IncomingMessage;

    expect(() => authorizer.require(request, "user-a")).toThrow(
      UnauthorizedError,
    );
  });
});
