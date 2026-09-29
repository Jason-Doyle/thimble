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
  CLIENT_WRITE_INDEX_SETS,
  CLIENT_WRITE_MODES,
  benchmarkDocuments,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_CLIENT_WRITE_OUTPUT ??
    ".bench-data/client-assisted-trie-writes-regional",
);
await rm(root, { recursive: true, force: true });
const baseRoot = path.join(root, "base");
const objectsRoot = path.join(root, "objects");
await mkdir(baseRoot, { recursive: true });
await mkdir(objectsRoot, { recursive: true });

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 173,
);
const contextSigningKey = Uint8Array.from(
  { length: 32 },
  (_, index) => 255 - index,
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
    CLIENT_WRITE_INDEX_SETS,
  )) {
    const base = path.join(
      baseRoot,
      profile,
      indexSet,
    );
    await writeLayout(base, indexes, documents);
    matrix[profile][indexSet] =
      await inventory(base);
    for (const region of BENCHMARK_REGIONS) {
      for (const mode of CLIENT_WRITE_MODES) {
        await cp(
          base,
          path.join(
            objectsRoot,
            "client-write",
            region,
            profile,
            indexSet,
            mode,
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
  contextSigningKeyBase64:
    bytesToBase64(contextSigningKey),
  keyId: BENCHMARK_KEY_ID,
  scopeId: BENCHMARK_SCOPE_ID,
  collection: BENCHMARK_COLLECTION,
  profiles: BENCHMARK_PROFILES,
  indexSets: Object.fromEntries(
    Object.entries(
      CLIENT_WRITE_INDEX_SETS,
    ).map(([name, indexes]) => [
      name,
      {
        count: indexes.notes?.length ?? 0,
        indexes,
      },
    ]),
  ),
  modes: CLIENT_WRITE_MODES,
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
  await new ContentAddressedTrieEngine(
    store,
    40,
    undefined,
    false,
    indexes,
  ).putMany(
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
