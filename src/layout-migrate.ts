import type { JsonValue } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { ImmutableSnapshotEngine } from "./engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import { PrefixObjectStore } from "./prefix-store.js";
import { loadScopeMaterial } from "./server-keys.js";
import { stableStringify } from "./shared-utils.js";
import type { CollectionLayout } from "./snapshot-protocol.js";
import {
  createConfiguredProviderStore,
  parseProvider,
} from "./providers/configured.js";
import { scopeStoragePrefix } from "./trie-protocol.js";

if (process.env.THIMBLE_MIGRATION_QUIESCENT !== "true") {
  throw new Error(
    "Set THIMBLE_MIGRATION_QUIESCENT=true only after writes are blocked",
  );
}

const provider = process.env.THIMBLE_PROVIDER ?? "local";
const scopeId = required("THIMBLE_SCOPE_ID");
const collection = required("THIMBLE_COLLECTION");
const sourceLayout = layout(required("THIMBLE_SOURCE_LAYOUT"));
const targetLayout = layout(required("THIMBLE_TARGET_LAYOUT"));
if (sourceLayout === targetLayout) {
  throw new Error("Source and target layouts must differ");
}
const prefix = process.env.THIMBLE_PREFIX ?? "demo";
const versions = configuredVersions();
const materials = await Promise.all(
  versions.map((keyVersion) =>
    loadScopeMaterial({
      scopeId,
      encrypted: true,
      keyVersion,
      local: provider === "local",
    }),
  ),
);
const writeMaterial = materials[0]!;
const decryptionKeys = new Map(
  materials.map(
    (material) =>
      [material.keyId!, material.key!] as const,
  ),
);
const scopePrefix = scopeStoragePrefix(scopeId);
const store = new EnvelopeObjectStore(
  new PrefixObjectStore(
    new PrefixObjectStore(
      await createConfiguredProviderStore(parseProvider(provider), "data"),
      prefix,
    ),
    scopePrefix,
  ),
  {
    key: writeMaterial.key!,
    keyId: writeMaterial.keyId!,
    decryptionKeys,
    compression: "gzip",
    objectKeyPrefix: scopePrefix,
  },
);
const trie = new ContentAddressedTrieEngine(
  store,
  40,
  writeMaterial.addressNode,
);
const snapshot = new ImmutableSnapshotEngine(
  store,
  40,
  writeMaterial.addressNode,
);
const source = sourceLayout === "trie" ? trie : snapshot;
const target = targetLayout === "trie" ? trie : snapshot;
if ((await source.retainedDeletionCount(collection)) > 0) {
  throw new Error(
    "Resolve or purge retained deletions before changing layout",
  );
}
const documents = await source.exportStored(collection);
await target.replaceStored(collection, documents);
const verified = await target.exportStored(collection);
if (
  stableStringify(verified as unknown as JsonValue) !==
  stableStringify(documents as unknown as JsonValue)
) {
  throw new Error("Target layout verification failed");
}
console.log(
  `${scopeId}/${collection}: migrated ${documents.length} documents from ${sourceLayout} to ${targetLayout}`,
);
materials.forEach((material) => material.rawKey?.fill(0));

function layout(value: string): CollectionLayout {
  if (value === "trie" || value === "snapshot") {
    return value;
  }
  throw new Error(`Unsupported layout: ${value}`);
}

function configuredVersions(): number[] {
  const writeVersion = integer(
    process.env.THIMBLE_KEY_VERSION,
    1,
  );
  const historical = (
    process.env.THIMBLE_READ_KEY_VERSIONS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => integer(value, writeVersion));
  return [
    writeVersion,
    ...historical.filter((value) => value !== writeVersion),
  ];
}

function integer(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
