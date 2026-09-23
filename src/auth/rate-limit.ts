import type { JsonValue, ObjectStore } from "../core.js";
import {
  decodeJson,
  encodeJson,
  isPreconditionFailure,
} from "../shared-utils.js";

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface AuthRateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}

export class RoutedAuthRateLimiter implements AuthRateLimiter {
  constructor(
    private readonly durable: AuthRateLimiter,
    private readonly edgeIp: AuthRateLimiter,
  ) {}

  consume(key: string): Promise<RateLimitResult> {
    return /^(register|login|external)-ip:/.test(key)
      ? this.edgeIp.consume(key)
      : this.durable.consume(key);
  }
}

export class InMemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly entries = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  async consume(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      this.entries.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count <= this.limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1_000),
      ),
    };
  }

}

type RateLimitRecord = {
  count: number;
  resetAt: number;
};

export class ObjectStoreAuthRateLimiter implements AuthRateLimiter {
  constructor(
    private readonly store: ObjectStore,
    private readonly hashKey: (
      value: string,
    ) => Promise<string> | string,
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  async consume(key: string): Promise<RateLimitResult> {
    const storageKey = `rate-limits/${await this.hashKey(key)}.json`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const existing = await this.store.get(storageKey);
      const now = Date.now();
      const current = existing
        ? decodeJson<RateLimitRecord>(existing.bytes)
        : null;
      const next: RateLimitRecord =
        !current || current.resetAt <= now
          ? {
              count: 1,
              resetAt: now + this.windowMs,
            }
          : {
              count: current.count + 1,
              resetAt: current.resetAt,
            };
      try {
        await this.store.put(
          storageKey,
          encodeJson(next as unknown as JsonValue),
          existing
            ? { ifMatch: existing.etag }
            : { ifNoneMatch: true },
        );
        return {
          allowed: next.count <= this.limit,
          retryAfterSeconds:
            next.count <= this.limit
              ? 0
              : Math.max(
                  1,
                  Math.ceil((next.resetAt - now) / 1_000),
                ),
        };
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
      }
    }
    return { allowed: false, retryAfterSeconds: 60 };
  }

}
