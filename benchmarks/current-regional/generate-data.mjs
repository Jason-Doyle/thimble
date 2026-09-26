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
} from "../../src/engines/content-trie.ts";
import {
  ImmutableSnapshotEngine,
} from "../../src/engines/immutable-snapshot.ts";
import { EnvelopeObjectStore } from "../../src/envelope-store.ts";
import {
  bytesToBase64,
  DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  encodeEnvelope,
  importAesGcmKey,
} from "../../src/envelope.ts";
import { PrefixObjectStore } from "../../src/prefix-store.ts";
import {
  encodeJson,
} from "../../src/shared-utils.ts";
import { LocalObjectStore } from "../../src/stores.ts";
import { scopeStoragePrefix } from "../../src/trie-protocol.ts";
import {
  BENCHMARK_COLLECTION,
  BENCHMARK_INDEXES,
  BENCHMARK_KEY_ID,
  BENCHMARK_PROFILES,
  BENCHMARK_REGIONS,
  BENCHMARK_SCOPE_ID,
  benchmarkDocuments,
  benchmarkExpectations,
  benchmarkPointIds,
} from "./scenario.ts";

const root = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_OUTPUT ??
    ".bench-data/current-regional",
);
await rm(root, { recursive: true, force: true });
const objectsRoot = path.join(root, "objects");
await mkdir(objectsRoot, { recursive: true });

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 71,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const profiles = {};

for (const [profile, count] of Object.entries(
  BENCHMARK_PROFILES,
)) {
  const documents = benchmarkDocuments(count);
  profiles[profile] = {
    documents: count,
    pointIds: benchmarkPointIds(count),
    expected: benchmarkExpectations(count),
    decodedSnapshotBytes: encodeJson({
      documents: Object.fromEntries(
        documents.map((document) => [
          document.id,
          document,
        ]),
      ),
    }).byteLength,
    layouts: {},
  };
  for (const layout of ["snapshot", "trie"]) {
    const directory = path.join(
      objectsRoot,
      "read",
      profile,
      layout,
    );
    await writeLayout(directory, layout, documents);
    profiles[profile].layouts[layout] =
      await inventory(directory);
  }
}

for (const region of BENCHMARK_REGIONS) {
  for (const layout of ["snapshot", "trie"]) {
    await copyLargeLayout(
      path.join("write", "single", region, layout),
      layout,
    );
  }
}
for (const replicate of ["a", "b"]) {
  for (const layout of ["snapshot", "trie"]) {
    await copyLargeLayout(
      path.join("write", "contention", replicate, layout),
      layout,
    );
  }
}

const oversized = new TextEncoder().encode(
  "x".repeat(DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES + 1),
);
const oversizedEnvelope = await encodeEnvelope(oversized, {
  compression: "gzip",
  maximumDecodedBytes: oversized.byteLength,
});
await mkdir(path.join(objectsRoot, "limit"), {
  recursive: true,
});
await writeFile(
  path.join(objectsRoot, "limit", "oversized.tdb"),
  oversizedEnvelope,
);

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
  decodedObjectLimit:
    DEFAULT_MAXIMUM_DECODED_ENVELOPE_BYTES,
  profiles,
  regions: BENCHMARK_REGIONS,
  writeDatasets: {
    single: BENCHMARK_REGIONS.length * 2,
    contention: 4,
  },
  limitFixture: {
    key: "limit/oversized.tdb",
    decodedBytes: oversized.byteLength,
    storedBytes: oversizedEnvelope.byteLength,
  },
  total: await inventory(objectsRoot),
};
await writeFile(
  path.join(root, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest, null, 2));

async function writeLayout(directory, layout, documents) {
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
  await engine.putMany(BENCHMARK_COLLECTION, documents);
}

async function copyLargeLayout(relativeTarget, layout) {
  const source = path.join(
    objectsRoot,
    "read",
    "large",
    layout,
  );
  const target = path.join(objectsRoot, relativeTarget);
  await cp(source, target, { recursive: true });
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
