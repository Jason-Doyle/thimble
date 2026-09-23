import { describe, expect, it, vi } from "vitest";
import { AsyncLruCache } from "../src/async-lru-cache.js";

describe("AsyncLruCache", () => {
  it("rejects configurations that cannot retain an entry", () => {
    expect(
      () =>
        new AsyncLruCache<string, string>({
          maxEntries: 0,
          ttlMs: 60_000,
        }),
    ).toThrow("positive integer");
  });

  it("bounds retained scope runtimes and disposes evicted values", async () => {
    const dispose = vi.fn();
    const cache = new AsyncLruCache<string, { id: string }>({
      maxEntries: 2,
      ttlMs: 60_000,
      dispose,
    });

    await cache.get("one", async () => ({ id: "one" }));
    await cache.get("two", async () => ({ id: "two" }));
    await cache.get("three", async () => ({ id: "three" }));
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledWith({ id: "one" });
  });

  it("does not retain rejected initialisation promises", async () => {
    const cache = new AsyncLruCache<string, string>({
      maxEntries: 2,
      ttlMs: 60_000,
    });
    await expect(
      cache.get("scope", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      cache.get("scope", async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("does not let an evicted rejection remove its replacement", async () => {
    const cache = new AsyncLruCache<string, string>({
      maxEntries: 1,
      ttlMs: 60_000,
    });
    let rejectInitial:
      | ((reason: Error) => void)
      | undefined;
    const initial = cache.get(
      "scope",
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectInitial = reject;
        }),
    );
    const initialRejection = expect(initial).rejects.toThrow(
      "initialisation failed",
    );

    await cache.get("other", async () => "other");
    const replacement = cache.get(
      "scope",
      async () => "replacement",
    );
    rejectInitial?.(new Error("initialisation failed"));

    await initialRejection;
    await expect(replacement).resolves.toBe("replacement");
    await expect(
      cache.get("scope", async () => "unexpected"),
    ).resolves.toBe("replacement");
  });
});
