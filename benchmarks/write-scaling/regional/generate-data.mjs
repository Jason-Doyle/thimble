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
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  WRITE_SCALING_INDEX_SETS,
  WRITE_SCALING_LAYOUTS,
  benchmarkDocuments,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_OUTPUT ??
    ".bench-data/write-scaling-regional",
);
await rm(root, { recursive: true, force: true });
const baseRoot = path.join(root, "base");
const objectsRoot = path.join(root, "objects");
await mkdir(baseRoot, { recursive: true });
await mkdir(objectsRoot, { recursive: true });

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 141,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const matrix = {};

for (const [profile, count] of Object.entries(
  BENCHMARK_PROFILES,
)) {
  const documents = benchmarkDocuments(count);
  matrix[profile] = {};
  for (const [indexSet, indexes] of Object.entries(
    WRITE_SCALING_INDEX_SETS,
  )) {
    matrix[profile][indexSet] = {};
    for (const layout of WRITE_SCALING_LAYOUTS) {
      const base = path.join(
        baseRoot,
        profile,
        indexSet,
        layout,
      );
      await writeLayout(
        base,
        layout,
        indexes,
        documents,
      );
      matrix[profile][indexSet][layout] =
        await inventory(base);
      for (const region of BENCHMARK_REGIONS) {
        await cp(
          base,
          path.join(
            objectsRoot,
            "write",
            region,
            profile,
            indexSet,
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
  profiles: BENCHMARK_PROFILES,
  indexSets: Object.fromEntries(
    Object.entries(
      WRITE_SCALING_INDEX_SETS,
    ).map(([name, indexes]) => [
      name,
      {
        count: indexes.notes?.length ?? 0,
        indexes,
      },
    ]),
  ),
  layouts: WRITE_SCALING_LAYOUTS,
  regions: BENCHMARK_REGIONS,
  matrix,
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
  indexes,
  documents,
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
          indexes,
        )
      : new ContentAddressedTrieEngine(
          store,
          40,
          undefined,
          false,
          indexes,
        );
  await engine.putMany(
    BENCHMARK_COLLECTION,
    documents,
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
