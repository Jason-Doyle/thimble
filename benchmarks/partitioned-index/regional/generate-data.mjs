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
import { encodeJson } from "../../../src/shared-utils.ts";
import { LocalObjectStore } from "../../../src/stores.ts";
import { scopeStoragePrefix } from "../../../src/trie-protocol.ts";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  PARTITIONED_INDEX_CONFIGURATION,
  PARTITIONED_INDEX_DOCUMENTS,
  PARTITIONED_INDEX_SHARDS,
  PARTITIONED_INDEX_VARIANTS,
  benchmarkDocuments,
  benchmarkExpectations,
  benchmarkPointIds,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_PARTITIONED_REGIONAL_OUTPUT ??
    ".bench-data/partitioned-index-regional",
);
await rm(root, { recursive: true, force: true });
const objectsRoot = path.join(root, "objects");
await mkdir(objectsRoot, { recursive: true });

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 101,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const documents = benchmarkDocuments(
  PARTITIONED_INDEX_DOCUMENTS,
);
const layouts = {};

for (const variant of PARTITIONED_INDEX_VARIANTS) {
  layouts[variant] = {};
  for (const layout of ["snapshot", "trie"]) {
    const directory = path.join(
      objectsRoot,
      "read",
      variant,
      layout,
    );
    await writeLayout(
      directory,
      variant,
      layout,
      documents,
    );
    layouts[variant][layout] = await inventory(directory);
    for (const region of BENCHMARK_REGIONS) {
      await cp(
        directory,
        path.join(
          objectsRoot,
          "write",
          "single",
          region,
          variant,
          layout,
        ),
        { recursive: true },
      );
    }
    for (const replicate of ["a", "b"]) {
      await cp(
        directory,
        path.join(
          objectsRoot,
          "write",
          "contention",
          replicate,
          variant,
          layout,
        ),
        { recursive: true },
      );
    }
  }
}

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceCommit:
    process.env.THIMBLE_BENCHMARK_SOURCE_COMMIT ?? null,
  harnessCommit:
    process.env.THIMBLE_BENCHMARK_HARNESS_COMMIT ?? null,
  keyBase64: bytesToBase64(rawKey),
  keyId: BENCHMARK_KEY_ID,
  scopeId: BENCHMARK_SCOPE_ID,
  collection: BENCHMARK_COLLECTION,
  documents: PARTITIONED_INDEX_DOCUMENTS,
  partitionCount: PARTITIONED_INDEX_SHARDS,
  pointIds: benchmarkPointIds(PARTITIONED_INDEX_DOCUMENTS),
  expected: benchmarkExpectations(
    PARTITIONED_INDEX_DOCUMENTS,
  ),
  decodedSnapshotBytes: encodeJson({
    documents: Object.fromEntries(
      documents.map((document) => [
        document.id,
        document,
      ]),
    ),
  }).byteLength,
  regions: BENCHMARK_REGIONS,
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
  variant,
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
  const partitionConfiguration =
    variant === "partitioned"
      ? PARTITIONED_INDEX_CONFIGURATION
      : {};
  const engine =
    layout === "snapshot"
      ? new ImmutableSnapshotEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
          false,
          partitionConfiguration,
        )
      : new ContentAddressedTrieEngine(
          store,
          40,
          undefined,
          false,
          BENCHMARK_INDEXES,
          false,
          partitionConfiguration,
        );
  await engine.putMany(BENCHMARK_COLLECTION, values);
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
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
