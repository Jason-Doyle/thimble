import {
  cp,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  ContentAddressedTrieEngine,
} from "../../../src/engines/content-trie.ts";
import {
  ImmutableSnapshotEngine,
} from "../../../src/engines/immutable-snapshot.ts";
import { EnvelopeObjectStore } from "../../../src/envelope-store.ts";
import {
  bytesToBase64,
  importAesGcmKey,
} from "../../../src/envelope.ts";
import { PrefixObjectStore } from "../../../src/prefix-store.ts";
import { LocalObjectStore } from "../../../src/stores.ts";
import { scopeStoragePrefix } from "../../../src/trie-protocol.ts";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  MUTATION_BATCH_DOCUMENTS,
  MUTATION_BATCH_SIZES,
  MUTATION_BATCH_VARIANTS,
  WRITE_SCALING_LAYOUTS,
  benchmarkDocuments,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_MUTATION_BATCH_OUTPUT ??
    ".bench-data/mutation-batching",
);
await rm(root, { recursive: true, force: true });
const baseRoot = path.join(root, "base");
const objectsRoot = path.join(root, "objects");
await mkdir(baseRoot, { recursive: true });
await mkdir(objectsRoot, { recursive: true });

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 161,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const documents = benchmarkDocuments(
  MUTATION_BATCH_DOCUMENTS,
);
const layouts = {};

for (const layout of WRITE_SCALING_LAYOUTS) {
  const base = path.join(baseRoot, layout);
  await writeLayout(base, layout, documents);
  layouts[layout] = await inventory(base);
  for (const region of BENCHMARK_REGIONS) {
    for (const variant of MUTATION_BATCH_VARIANTS) {
      for (const batchSize of MUTATION_BATCH_SIZES) {
        await cp(
          base,
          path.join(
            objectsRoot,
            "write",
            region,
            variant,
            String(batchSize),
            layout,
          ),
          { recursive: true },
        );
      }
    }
  }
}

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceCommit:
    process.env.THIMBLE_BENCHMARK_SOURCE_COMMIT ??
      null,
  harnessCommit:
    process.env.THIMBLE_BENCHMARK_HARNESS_COMMIT ??
      null,
  keyBase64: bytesToBase64(rawKey),
  keyId: BENCHMARK_KEY_ID,
  scopeId: BENCHMARK_SCOPE_ID,
  collection: BENCHMARK_COLLECTION,
  documents: MUTATION_BATCH_DOCUMENTS,
  indexes: BENCHMARK_INDEXES,
  regions: BENCHMARK_REGIONS,
  variants: MUTATION_BATCH_VARIANTS,
  batchSizes: MUTATION_BATCH_SIZES,
  layouts,
  total: await inventory(objectsRoot),
};
await writeFile(
  path.join(root, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest, null, 2));

async function writeLayout(
  directory,
  layout,
  values,
) {
  await mkdir(directory, { recursive: true });
  const raw = new LocalObjectStore(directory);
  const scopePrefix = scopeStoragePrefix(
    BENCHMARK_SCOPE_ID,
  );
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(raw, scopePrefix),
    {
      key,
      keyId: BENCHMARK_KEY_ID,
      compression: "gzip",
      objectKeyPrefix: scopePrefix,
    },
  );
  const engine =
    layout === "snapshot"
      ? new ImmutableSnapshotEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
        )
      : new ContentAddressedTrieEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
        );
  await engine.putMany(
    BENCHMARK_COLLECTION,
    values,
  );
}

async function inventory(directory) {
  const files = await walk(directory);
  let bytes = 0;
  for (const file of files) {
    bytes += (await stat(file)).size;
  }
  return {
    objects: files.length,
    bytes,
  };
}

async function walk(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(
      directory,
      entry.name,
    );
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
