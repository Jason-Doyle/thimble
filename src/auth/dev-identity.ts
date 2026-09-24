import type {
  ExternalIdentity,
  IdentityAdapter,
} from "./types.js";

export const DEVELOPMENT_IDENTITY_ADAPTER_ID = "dev";
export const DEVELOPMENT_IDENTITY_TOKEN =
  "thimbledb-local-development";

export function validateDevelopmentIdentity(options: {
  enabled: boolean;
  nodeEnvironment?: string;
  provider: string;
  host: string;
  allowedOrigin: string;
}): boolean {
  if (!options.enabled) {
    return false;
  }
  if (options.nodeEnvironment === "production") {
    throw new Error(
      "THIMBLE_DEV_IDENTITY cannot be enabled in production",
    );
  }
  if (options.provider !== "local") {
    throw new Error(
      "THIMBLE_DEV_IDENTITY requires THIMBLE_PROVIDER=local",
    );
  }
  if (!isLoopbackHostname(options.host)) {
    throw new Error(
      "THIMBLE_DEV_IDENTITY requires a loopback THIMBLE_HOST",
    );
  }
  const origin = new URL(options.allowedOrigin);
  if (!isLoopbackHostname(origin.hostname)) {
    throw new Error(
      "THIMBLE_DEV_IDENTITY requires a loopback THIMBLE_ALLOWED_ORIGIN",
    );
  }
  return true;
}

export class DevelopmentIdentityAdapter implements IdentityAdapter {
  readonly id = DEVELOPMENT_IDENTITY_ADAPTER_ID;

  constructor(
    private readonly options: {
      subject?: string;
      displayName?: string;
    } = {},
  ) {}

  authenticate(token: string): Promise<ExternalIdentity | null> {
    if (token !== DEVELOPMENT_IDENTITY_TOKEN) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      provider: "oidc",
      issuer: "urn:thimbledb:development",
      subject: this.options.subject ?? "local-developer",
      roles: ["thimble.user", "thimble.admin"],
      scopes: ["thimble.access"],
      displayName:
        this.options.displayName ?? "Local developer",
    });
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}
