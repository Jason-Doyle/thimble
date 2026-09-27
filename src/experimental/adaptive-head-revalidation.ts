import type {
  HeadRevalidationOutcome,
  HeadRevalidationPolicy,
} from "../browser/client.js";

export type ExperimentalHeadRevalidationDiagnostics = {
  notModified: number;
  changed: number;
  missing: number;
  resets: number;
  currentTtlMs: Record<string, number>;
};

export class ExperimentalCompletionTimedHeadRevalidation
implements HeadRevalidationPolicy {
  ttlMs(
    _key: string,
    configuredTtlMs: number,
  ): number {
    return configuredTtlMs;
  }

  complete(
    _key: string,
    _outcome: HeadRevalidationOutcome,
    _configuredTtlMs: number,
    _startedAt: number,
    completedAt: number,
  ): number {
    return completedAt;
  }

  reset(): void {}
}

export class ExperimentalAdaptiveHeadRevalidation
implements HeadRevalidationPolicy {
  private readonly intervals = new Map<string, number>();
  private notModified = 0;
  private changed = 0;
  private missing = 0;
  private resets = 0;

  constructor(
    private readonly options: {
      maximumTtlMs: number;
      multiplier?: number;
    },
  ) {
    if (
      !Number.isFinite(options.maximumTtlMs) ||
      options.maximumTtlMs < 0
    ) {
      throw new Error(
        "Adaptive HEAD maximum TTL must be non-negative",
      );
    }
    const multiplier = options.multiplier ?? 2;
    if (
      !Number.isFinite(multiplier) ||
      multiplier <= 1
    ) {
      throw new Error(
        "Adaptive HEAD multiplier must be greater than 1",
      );
    }
  }

  ttlMs(
    key: string,
    configuredTtlMs: number,
  ): number {
    return this.current(key, configuredTtlMs);
  }

  complete(
    key: string,
    outcome: HeadRevalidationOutcome,
    configuredTtlMs: number,
    _startedAt: number,
    completedAt: number,
  ): number {
    if (outcome === "not-modified") {
      this.notModified += 1;
      const current = this.current(
        key,
        configuredTtlMs,
      );
      this.intervals.set(
        key,
        Math.min(
          this.maximum(configuredTtlMs),
          Math.max(
            configuredTtlMs,
            current * (this.options.multiplier ?? 2),
          ),
        ),
      );
    } else {
      if (outcome === "changed") {
        this.changed += 1;
      } else {
        this.missing += 1;
      }
      this.intervals.set(key, configuredTtlMs);
    }
    return completedAt;
  }

  reset(
    key: string,
    configuredTtlMs: number,
  ): void {
    this.resets += 1;
    this.intervals.set(key, configuredTtlMs);
  }

  diagnostics(): ExperimentalHeadRevalidationDiagnostics {
    return {
      notModified: this.notModified,
      changed: this.changed,
      missing: this.missing,
      resets: this.resets,
      currentTtlMs: Object.fromEntries(
        [...this.intervals.entries()].sort(
          ([left], [right]) =>
            left.localeCompare(right),
        ),
      ),
    };
  }

  private current(
    key: string,
    configuredTtlMs: number,
  ): number {
    const value =
      this.intervals.get(key) ?? configuredTtlMs;
    return Math.min(
      this.maximum(configuredTtlMs),
      Math.max(configuredTtlMs, value),
    );
  }

  private maximum(configuredTtlMs: number): number {
    return Math.max(
      configuredTtlMs,
      this.options.maximumTtlMs,
    );
  }
}
