import type { JsonValue } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { ImmutableSnapshotEngine } from "./engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import { PrefixObjectStore } from "./prefix-store.js";
import {
  loadScopeMaterial,
  type ScopeMaterial,
} from "./server-keys.js";
import {
  createConfiguredProviderStore,
  parseProvider,
} from "./providers/configured.js";
import {
  scopeStoragePrefix,
} from "./trie-protocol.js";
import {
  createDictionary,
  stableStringify,
} from "./shared-utils.js";
import type { CollectionLayout } from "./snapshot-protocol.js";
import { parseIndexConfiguration } from "./secondary-index.js";

if (process.env.THIMBLE_MIGRATION_QUIESCENT !== "true") {
  throw new Error(
    "Set THIMBLE_MIGRATION_QUIESCENT=true only after writes are blocked",
  );
}

const provider = process.env.THIMBLE_PROVIDER ?? "local";
const scopeId = required("THIMBLE_SCOPE_ID");
const prefix = process.env.THIMBLE_PREFIX ?? "demo";
const collections = required("THIMBLE_COLLECTIONS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
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
const root = new PrefixObjectStore(
  await createConfiguredProviderStore(parseProvider(provider), "data"),
  prefix,
);
const scopePrefix = scopeStoragePrefix(scopeId);
const rawScopeStore = new PrefixObjectStore(root, scopePrefix);
const store = new EnvelopeObjectStore(
  rawScopeStore,
  {
    key: writeMaterial.key!,
    keyId: writeMaterial.keyId!,
    decryptionKeys,
    compression: "gzip",
    objectKeyPrefix: scopePrefix,
  },
);
const indexes = parseIndexConfiguration(
  process.env.THIMBLE_COLLECTION_INDEXES,
);
const trie = new ContentAddressedTrieEngine(
  store,
  40,
  writeMaterial.addressNode,
  false,
  indexes,
);
const snapshot = new ImmutableSnapshotEngine(
  store,
  40,
  writeMaterial.addressNode,
  false,
  indexes,
);
const verificationStore = new EnvelopeObjectStore(rawScopeStore, {
    key: writeMaterial.key!,
    keyId: writeMaterial.keyId!,
    compression: "gzip",
    objectKeyPrefix: scopePrefix,
  });
const verificationTrie = new ContentAddressedTrieEngine(
  verificationStore,
  40,
  writeMaterial.addressNode,
  false,
  indexes,
);
const verificationSnapshot = new ImmutableSnapshotEngine(
  verificationStore,
  40,
  writeMaterial.addressNode,
  false,
  indexes,
);
const layouts = collectionLayouts();

for (const collection of collections) {
  const layout = layouts[collection] ?? "trie";
  const engine = layout === "snapshot" ? snapshot : trie;
  const verificationEngine =
    layout === "snapshot"
      ? verificationSnapshot
      : verificationTrie;
  const documents = await engine.exportStored(collection);
  if (documents.length === 0) {
    console.log(`${collection}: no live collection to migrate`);
    continue;
  }
  await engine.replaceStored(collection, documents);
  const verified = await verificationEngine.exportStored(
    collection,
  );
  if (
    stableStringify(verified as unknown as JsonValue) !==
    stableStringify(documents as unknown as JsonValue)
  ) {
    throw new Error(
      `Collection ${collection} content changed during verification`,
    );
  }
  console.log(
    `${collection}: rewrote ${documents.length} stored records in ${layout} layout to ${writeMaterial.keyId}`,
  );
}

materials.forEach((material: ScopeMaterial) =>
  material.rawKey?.fill(0),
);

function collectionLayouts(): Record<string, CollectionLayout> {
  const layouts = createDictionary<CollectionLayout>();
  for (const entry of (
    process.env.THIMBLE_COLLECTION_LAYOUTS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [collection, layout] = entry.split("=");
    if (
      !collection ||
      (layout !== "trie" && layout !== "snapshot")
    ) {
      throw new Error(`Invalid collection layout: ${entry}`);
    }
    layouts[collection] = layout;
  }
  return layouts;
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
