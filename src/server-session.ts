import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";

export class DemoSessionAuthorizer {
  constructor(
    private readonly allowedScope: string,
    private readonly secret: string,
    private readonly maxAgeSeconds = 3_600,
  ) {}

  ensure(
    request: IncomingMessage,
    response: ServerResponse,
  ): string {
    const existing = this.token(request);
    if (existing && this.isAuthorized(existing, this.allowedScope)) {
      return existing;
    }

    const token = this.sign({
      expiresAt: Date.now() + this.maxAgeSeconds * 1_000,
      scopeId: this.allowedScope,
    });
    const secure =
      process.env.THIMBLE_SECURE_COOKIES === "true" ||
      request.headers["x-forwarded-proto"] === "https";
    response.setHeader(
      "set-cookie",
      [
        `thimble_session=${token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${this.maxAgeSeconds}`,
        secure ? "Secure" : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
    return token;
  }

  require(request: IncomingMessage, scopeId: string): void {
    const token = this.token(request);
    if (!token || !this.isAuthorized(token, scopeId)) {
      throw new UnauthorizedError();
    }
  }

  private isAuthorized(token: string, scopeId: string): boolean {
    const session = this.verify(token);
    if (!session || session.expiresAt <= Date.now()) {
      return false;
    }
    return session.scopeId === scopeId;
  }

  private token(request: IncomingMessage): string | null {
    const cookie = request.headers.cookie;
    if (!cookie) {
      return null;
    }
    for (const part of cookie.split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === "thimble_session") {
        return value.join("=") || null;
      }
    }
    return null;
  }

  private sign(payload: {
    scopeId: string;
    expiresAt: number;
  }): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verify(
    token: string,
  ): { scopeId: string; expiresAt: number } | null {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) {
      return null;
    }
    const expected = createHmac("sha256", this.secret)
      .update(encoded)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      return null;
    }
    if (
      expected.byteLength !== received.byteLength ||
      !timingSafeEqual(expected, received)
    ) {
      return null;
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as { scopeId?: unknown; expiresAt?: unknown };
      return typeof payload.scopeId === "string" &&
        typeof payload.expiresAt === "number"
        ? {
            scopeId: payload.scopeId,
            expiresAt: payload.expiresAt,
          }
        : null;
    } catch {
      return null;
    }
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication is required");
    this.name = "UnauthorizedError";
  }
}
