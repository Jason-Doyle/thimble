type Entry<V> = {
  value: Promise<V>;
  lastUsedAt: number;
};

export class AsyncLruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();

  constructor(
    private readonly options: {
      maxEntries: number;
      ttlMs: number;
      dispose?: (value: V) => void;
    },
  ) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("AsyncLruCache maxEntries must be a positive integer");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new Error("AsyncLruCache ttlMs must be non-negative");
    }
  }

  get(key: K, factory: () => Promise<V>): Promise<V> {
    this.evictExpired();
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value;
    }

    const entry: Entry<V> = {
      value: Promise.resolve(undefined as V),
      lastUsedAt: Date.now(),
    };
    const value = factory().catch((error) => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      throw error;
    });
    entry.value = value;
    this.entries.set(key, entry);
    this.evictOverflow();
    return value;
  }

  private evictExpired(): void {
    const threshold = Date.now() - this.options.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt > threshold) {
        continue;
      }
      this.entries.delete(key);
      void entry.value.then(
        (value) => this.options.dispose?.(value),
        () => undefined,
      );
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.entries().next().value as
        | [K, Entry<V>]
        | undefined;
      if (!oldest) {
        return;
      }
      this.entries.delete(oldest[0]);
      void oldest[1].value.then(
        (value) => this.options.dispose?.(value),
        () => undefined,
      );
    }
  }
}
