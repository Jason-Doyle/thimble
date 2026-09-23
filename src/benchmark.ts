import type {
  CacheMetrics,
  DatabaseEngine,
  EngineDiagnostics,
  JsonDocument,
  ObjectStore,
  StoreMetrics,
} from "./core.js";
import {
  CachedObjectStore,
  MeteredObjectStore,
} from "./stores.js";
import { percentile, round } from "./utils.js";
import {
  checkoutOrder,
  generateStoreDataset,
  updatedProduct,
  type StoreDataset,
  type WorkloadProfile,
} from "./workload.js";

export type PhaseResult = {
  name: string;
  durationMs: number;
  operationCount: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  store: StoreMetrics;
  cache: CacheMetrics;
  diagnostics: EngineDiagnostics;
};

export type EngineBenchmarkResult = {
  engine: string;
  phases: PhaseResult[];
  finalObjectCount: number;
  finalStoredBytes: number;
  diagnostics: EngineDiagnostics;
};

export type BenchmarkResult = {
  generatedAt: string;
  provider: string;
  profile: WorkloadProfile;
  simulatedLatencyMs: number;
  mutableCacheTtlMs: number;
  engines: EngineBenchmarkResult[];
};

export type EngineFactory = {
  name: string;
  create(store: ObjectStore): DatabaseEngine;
};

type RecordOperation = <T>(operation: () => Promise<T>) => Promise<T>;

export async function runBenchmark(options: {
  provider: string;
  profile: WorkloadProfile;
  simulatedLatencyMs: number;
  mutableCacheTtlMs: number;
  cacheMaxBytes: number;
  factories: EngineFactory[];
  createStore(engineName: string): Promise<ObjectStore> | ObjectStore;
}): Promise<BenchmarkResult> {
  const dataset = generateStoreDataset(options.profile);
  const engines: EngineBenchmarkResult[] = [];

  for (const factory of options.factories) {
    const rawStore = await options.createStore(factory.name);
    const store = new MeteredObjectStore(
      rawStore,
      options.simulatedLatencyMs,
    );
    const cache = new CachedObjectStore(store, {
      mutableTtlMs: options.mutableCacheTtlMs,
      maxBytes: options.cacheMaxBytes,
      maxEntries: 20_000,
    });
    const engine = factory.create(cache);
    const phases = await runEngineWorkload(
      engine,
      store,
      cache,
      dataset,
      options.profile,
    );
    const inventory = await measureInventory(store);
    engines.push({
      engine: engine.name,
      phases,
      finalObjectCount: inventory.objects,
      finalStoredBytes: inventory.bytes,
      diagnostics: engine.diagnostics(),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    provider: options.provider,
    profile: options.profile,
    simulatedLatencyMs: options.simulatedLatencyMs,
    mutableCacheTtlMs: options.mutableCacheTtlMs,
    engines,
  };
}

async function runEngineWorkload(
  engine: DatabaseEngine,
  store: MeteredObjectStore,
  cache: CachedObjectStore,
  dataset: StoreDataset,
  profile: WorkloadProfile,
): Promise<PhaseResult[]> {
  const phases: PhaseResult[] = [];

  phases.push(
    await runPhase("seed-and-snapshot", engine, store, cache, async (record) => {
      cache.setPolicy("content");
      cache.clear();
      await record(() => engine.putMany("products", dataset.products));
      await record(() => engine.putMany("customers", dataset.customers));
      await record(() => engine.putMany("orders", dataset.orders));
      await record(() => engine.compact("products"));
      await record(() => engine.compact("customers"));
      await record(() => engine.compact("orders"));
    }),
  );

  phases.push(
    await runPhase("cold-point-read", engine, store, cache, async (record) => {
      cache.setPolicy("none");
      for (let index = 0; index < profile.pointReads; index += 1) {
        const expected =
          dataset.products[(index * 37) % dataset.products.length];
        if (!expected) {
          throw new Error("Point-read workload has no product");
        }
        const actual = await record(() =>
          engine.get("products", expected.id),
        );
        if (actual?.id !== expected.id) {
          throw new Error(`Point read failed for ${expected.id}`);
        }
      }
    }),
  );

  phases.push(
    await runPhase("location-cache-point-read", engine, store, cache, async (record) => {
      cache.setPolicy("locations");
      cache.clear();
      const hotProducts = dataset.products.slice(0, 8);
      for (let index = 0; index < profile.pointReads; index += 1) {
        const expected = hotProducts[index % hotProducts.length];
        if (!expected) {
          throw new Error("Location-cache point-read workload has no product");
        }
        const actual = await record(() =>
          engine.get("products", expected.id),
        );
        if (actual?.id !== expected.id) {
          throw new Error(`Location-cache point read failed for ${expected.id}`);
        }
      }
    }),
  );

  phases.push(
    await runPhase("content-cache-point-read", engine, store, cache, async (record) => {
      cache.setPolicy("content");
      cache.clear();
      const hotProducts = dataset.products.slice(0, 8);
      for (let index = 0; index < profile.pointReads; index += 1) {
        const expected = hotProducts[index % hotProducts.length];
        if (!expected) {
          throw new Error("Content-cache point-read workload has no product");
        }
        const actual = await record(() =>
          engine.get("products", expected.id),
        );
        if (actual?.id !== expected.id) {
          throw new Error(`Content-cache point read failed for ${expected.id}`);
        }
      }
    }),
  );

  phases.push(
    await runPhase("cold-catalogue-scan", engine, store, cache, async (record) => {
      cache.setPolicy("none");
      cache.clear();
      const products = await record(() => engine.scan("products"));
      if (products.length < dataset.products.length) {
        throw new Error("Cold catalogue scan returned too few products");
      }
    }),
  );

  phases.push(
    await runPhase("location-cache-scan", engine, store, cache, async (record) => {
      cache.setPolicy("locations");
      cache.clear();
      for (let index = 0; index < profile.catalogueScans; index += 1) {
        const products = await record(() => engine.scan("products"));
        if (products.length < dataset.products.length) {
          throw new Error("Location-cache scan returned too few products");
        }
      }
    }),
  );

  phases.push(
    await runPhase("content-cache-scan", engine, store, cache, async (record) => {
      cache.setPolicy("content");
      cache.clear();
      for (let index = 0; index < profile.catalogueScans; index += 1) {
        const products = await record(() => engine.scan("products"));
        const category = ["home", "office", "electronics"][index % 3];
        const matches = products.filter(
          (product) => product.category === category,
        );
        if (matches.length === 0) {
          throw new Error(`Catalogue scan found no ${category} products`);
        }
      }
    }),
  );

  phases.push(
    await runPhase("sequential-updates", engine, store, cache, async (record) => {
      cache.setPolicy("locations");
      cache.clear();
      for (let index = 0; index < profile.updates; index += 1) {
        const product = dataset.products[index % dataset.products.length];
        if (!product) {
          throw new Error("Update workload has no product");
        }
        await record(() =>
          engine.put(
            "products",
            product.id,
            updatedProduct(product, index),
          ),
        );
      }
    }),
  );

  phases.push(
    await runPhase("concurrent-writes", engine, store, cache, async (record) => {
      cache.setPolicy("locations");
      cache.clear();
      const writes = Array.from(
        { length: profile.concurrentWrites },
        (_, index) => {
          const document: JsonDocument = {
            id: `flash-${index.toString().padStart(5, "0")}`,
            sku: `FLASH-${index}`,
            name: `Flash product ${index}`,
            category: "flash",
            priceCents: 1_000 + index,
            stock: 10,
            active: true,
          };
          return record(() =>
            engine.put("products", document.id, document),
          );
        },
      );
      await Promise.all(writes);
    }),
  );

  phases.push(
    await runPhase("checkout-flow", engine, store, cache, async (record) => {
      cache.setPolicy("content");
      cache.clear();
      for (let index = 0; index < profile.checkouts; index += 1) {
        const original =
          dataset.products[(index * 11) % dataset.products.length];
        const customer =
          dataset.customers[(index * 7) % dataset.customers.length];
        if (!original || !customer) {
          throw new Error("Checkout workload is missing seed data");
        }

        await record(async () => {
          const product = await engine.get("products", original.id);
          if (!product) {
            throw new Error(`Checkout product ${original.id} is missing`);
          }
          const stock =
            typeof product.stock === "number" ? product.stock : 0;
          const nextProduct: JsonDocument = {
            ...product,
            stock: Math.max(0, stock - 1),
          };
          const order = checkoutOrder(index, product, customer);

          await engine.put("products", nextProduct.id, nextProduct);
          await engine.put("orders", order.id, order);
        });
      }
    }),
  );

  phases.push(
    await runPhase("maintenance", engine, store, cache, async (record) => {
      cache.setPolicy("none");
      cache.clear();
      await record(() => engine.compact("products"));
      await record(() => engine.compact("customers"));
      await record(() => engine.compact("orders"));
    }),
  );

  phases.push(
    await runPhase("post-maintenance-read", engine, store, cache, async (record) => {
      cache.setPolicy("none");
      cache.clear();
      const product = dataset.products[0];
      if (!product) {
        throw new Error("Post-maintenance workload has no product");
      }
      const actual = await record(() =>
        engine.get("products", product.id),
      );
      if (!actual) {
        throw new Error("Post-maintenance read failed");
      }
    }),
  );

  return phases;
}

async function runPhase(
  name: string,
  engine: DatabaseEngine,
  store: MeteredObjectStore,
  cache: CachedObjectStore,
  workload: (record: RecordOperation) => Promise<void>,
): Promise<PhaseResult> {
  store.reset();
  cache.resetMetrics();
  const before = engine.diagnostics();
  const latencies: number[] = [];
  const started = performance.now();

  const record = async <T>(operation: () => Promise<T>): Promise<T> => {
    const operationStarted = performance.now();
    try {
      return await operation();
    } finally {
      latencies.push(performance.now() - operationStarted);
    }
  };

  await workload(record);
  const durationMs = performance.now() - started;
  const metrics = store.snapshot(true);
  const cacheMetrics = cache.snapshot(true);

  return {
    name,
    durationMs: round(durationMs),
    operationCount: latencies.length,
    latencyP50Ms: round(percentile(latencies, 50)),
    latencyP95Ms: round(percentile(latencies, 95)),
    store: roundMetrics(metrics),
    cache: cacheMetrics,
    diagnostics: subtractDiagnostics(engine.diagnostics(), before),
  };
}

async function measureInventory(
  store: MeteredObjectStore,
): Promise<{ objects: number; bytes: number }> {
  store.reset();
  const keys = await store.list("");
  let bytes = 0;
  for (const key of keys) {
    const object = await store.get(key);
    bytes += object?.bytes.byteLength ?? 0;
  }
  store.reset();
  return { objects: keys.length, bytes };
}

function subtractDiagnostics(
  after: EngineDiagnostics,
  before: EngineDiagnostics,
): EngineDiagnostics {
  const result: EngineDiagnostics = {};
  for (const [key, value] of Object.entries(after)) {
    result[key] = value - (before[key] ?? 0);
  }
  return result;
}

function roundMetrics(metrics: StoreMetrics): StoreMetrics {
  return {
    get: {
      ...metrics.get,
      durationMs: round(metrics.get.durationMs),
    },
    put: {
      ...metrics.put,
      durationMs: round(metrics.put.durationMs),
    },
    delete: {
      ...metrics.delete,
      durationMs: round(metrics.delete.durationMs),
    },
    list: {
      ...metrics.list,
      durationMs: round(metrics.list.durationMs),
    },
    preconditionFailures: metrics.preconditionFailures,
  };
}
