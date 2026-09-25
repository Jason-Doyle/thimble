import {
  mkdir,
  readFile,
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
  encodeEnvelope,
  importAesGcmKey,
} from "../../../src/envelope.ts";
import {
  buildIndexedSegment,
} from "../../../src/experimental/indexed-segment.ts";
import {
  ExperimentalManifestedSegmentEngine,
} from "../../../src/experimental/manifested-segment.ts";
import {
  encodeJson,
} from "../../../src/shared-utils.ts";
import { LocalObjectStore } from "../../../src/stores.ts";

const root = path.resolve(
  process.env.THIMBLE_REGIONAL_OUTPUT ??
    ".bench-data/indexed-segment-regional",
);
const documents = Number(
  process.env.THIMBLE_REGIONAL_DOCUMENTS ?? "50000",
);
if (
  !Number.isInteger(documents) ||
  documents < 1_000 ||
  documents > 100_000
) {
  throw new Error(
    "THIMBLE_REGIONAL_DOCUMENTS must be 1000-100000",
  );
}

await rm(root, { recursive: true, force: true });
const objectsRoot = path.join(root, "objects");
const snapshotRoot = path.join(objectsRoot, "snapshot");
const trieRoot = path.join(objectsRoot, "trie");
const experimentalRoot = path.join(
  objectsRoot,
  "experimental",
);
const manifestedRoot = path.join(
  objectsRoot,
  "manifested",
);
await Promise.all([
  mkdir(snapshotRoot, { recursive: true }),
  mkdir(trieRoot, { recursive: true }),
  mkdir(experimentalRoot, { recursive: true }),
  mkdir(manifestedRoot, { recursive: true }),
]);

const rawKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 31,
);
const key = await importAesGcmKey(
  rawKey,
  ["encrypt", "decrypt"],
);
const fingerprintKey = await crypto.subtle.importKey(
  "raw",
  rawKey,
  {
    name: "HMAC",
    hash: "SHA-256",
  },
  false,
  ["sign"],
);
const keyId = "regional-benchmark-v1";
const context = "regional-benchmark/notes";
const dataset = notes(documents);

const snapshotRaw = new LocalObjectStore(snapshotRoot);
const snapshot = new ImmutableSnapshotEngine(
  new EnvelopeObjectStore(snapshotRaw, {
    key,
    keyId,
    compression: "gzip",
  }),
);
await snapshot.putMany("notes", dataset);

const trieRaw = new LocalObjectStore(trieRoot);
const trie = new ContentAddressedTrieEngine(
  new EnvelopeObjectStore(trieRaw, {
    key,
    keyId,
    compression: "gzip",
  }),
);
await trie.putMany("notes", dataset);

const segment = await buildIndexedSegment(dataset, {
  targetBlockBytes: 64 * 1024,
  fields: [
    { field: "category", mode: "equality" },
    { field: "bucket", mode: "equality" },
    { field: "lastModified", mode: "range" },
  ],
  security: {
    key,
    keyId,
    fingerprintKey,
    context,
  },
});
await writeFile(
  path.join(experimentalRoot, "notes.tis"),
  segment,
);

const manifestedRaw = new LocalObjectStore(manifestedRoot);
const manifested = new ExperimentalManifestedSegmentEngine(
  new EnvelopeObjectStore(manifestedRaw, {
    key,
    keyId,
    compression: "gzip",
  }),
  {
    targetBlockBytes: 256 * 1024,
    collectionFields: {
      notes: [
        { field: "category", mode: "equality" },
        { field: "bucket", mode: "equality" },
        { field: "lastModified", mode: "range" },
      ],
    },
  },
);
await manifested.putMany("notes", dataset);

const snapshotPortable = await encodeEnvelope(
  encodeJson({
    documents: Object.fromEntries(
      dataset.map((document) => [document.id, document]),
    ),
  }),
  {
    key,
    keyId,
    compression: "gzip",
    additionalData: new TextEncoder().encode(
      "portable-snapshot",
    ),
  },
);
await writeFile(
  path.join(objectsRoot, "portable-snapshot.tdb"),
  snapshotPortable,
);

const manifest = {
  generatedAt: new Date().toISOString(),
  documents,
  keyBase64: bytesToBase64(rawKey),
  keyId,
  context,
  collection: "notes",
  pointIds: sampledIds(dataset),
  expected: {
    clusteredCategory: "rare",
    clusteredMatches: dataset.filter(
      (document) => document.category === "rare",
    ).length,
    distributedBucket: "bucket-07",
    distributedMatches: dataset.filter(
      (document) => document.bucket === "bucket-07",
    ).length,
    rangeLower: Math.floor(documents * 0.7),
    rangeUpper:
      Math.floor(documents * 0.7) + 24,
    rangeMatches: 25,
  },
  objects: {
    snapshot: await inventory(snapshotRoot),
    trie: await inventory(trieRoot),
    experimental: await inventory(experimentalRoot),
    manifested: await inventory(manifestedRoot),
    portableSnapshot: {
      objects: 1,
      bytes: snapshotPortable.byteLength,
    },
  },
};
await writeFile(
  path.join(root, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest, null, 2));

function notes(count) {
  const rareCount = Math.max(1, Math.floor(count * 0.05));
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${String(index).padStart(6, "0")}`,
    title: `Note ${index % 50}`,
    category:
      index < rareCount
        ? "rare"
        : index < Math.floor(count / 2)
          ? "work"
          : "personal",
    bucket: `bucket-${String(index % 20).padStart(2, "0")}`,
    body:
      `Deterministic regional benchmark note ${index}. ` +
      `${"content ".repeat(18)}${index % 17}`,
    lastModified: index,
    active: index % 5 !== 0,
  }));
}

function sampledIds(values) {
  return Array.from(
    { length: 100 },
    (_, index) =>
      values[(index * 977) % values.length].id,
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
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
