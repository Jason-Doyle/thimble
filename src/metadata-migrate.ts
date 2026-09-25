import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { ImmutableSnapshotEngine } from "./engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import { PrefixObjectStore } from "./prefix-store.js";
import {
  createConfiguredProviderStore,
  parseProvider,
} from "./providers/configured.js";
import {
  loadScopeMaterial,
  type ScopeMaterial,
} from "./server-keys.js";
import { parseIndexConfiguration } from "./secondary-index.js";
import {
  createDictionary,
  stableStringify,
} from "./shared-utils.js";
import type { CollectionLayout } from "./snapshot-protocol.js";
import { scopeStoragePrefix } from "./trie-protocol.js";

type MetadataMigrationEngine = Pick<
  ContentAddressedTrieEngine,
  "exportStored" | "replaceStored"
>;

export async function migrateMetadataFromEnvironment(): Promise<void> {
  if (process.env.THIMBLE_MIGRATION_QUIESCENT !== "true") {
    throw new Error(
      "Set THIMBLE_MIGRATION_QUIESCENT=true only after writes are blocked",
    );
  }
  const provider = parseProvider(
    process.env.THIMBLE_PROVIDER ?? "local",
  );
  const scopeId = required("THIMBLE_SCOPE_ID");
  const collections = required("THIMBLE_COLLECTIONS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    collections.length === 0 ||
    new Set(collections).size !== collections.length
  ) {
    throw new Error(
      "THIMBLE_COLLECTIONS must contain unique collection names",
    );
  }
  const encrypted = scopeId !== "public";
  const versions = encrypted ? configuredVersions() : [1];
  const materials = await Promise.all(
    versions.map((keyVersion) =>
      loadScopeMaterial({
        scopeId,
        encrypted,
        keyVersion,
        local: provider === "local",
      }),
    ),
  );
  try {
    const writeMaterial = materials[0]!;
    const prefix = process.env.THIMBLE_PREFIX ?? "demo";
    const scopePrefix = scopeStoragePrefix(scopeId);
    const scopedStore = new PrefixObjectStore(
      new PrefixObjectStore(
        await createConfiguredProviderStore(provider, "data"),
        prefix,
      ),
      scopePrefix,
    );
    const store = new EnvelopeObjectStore(
      scopedStore,
      encrypted
        ? {
            key: writeMaterial.key!,
            keyId: writeMaterial.keyId!,
            decryptionKeys: new Map(
              materials.map(
                (material) =>
                  [material.keyId!, material.key!] as const,
              ),
            ),
            compression: "gzip",
            objectKeyPrefix: scopePrefix,
          }
        : {
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
    const layouts = configuredLayouts();
    for (const collection of collections) {
      const engine =
        layouts[collection] === "snapshot" ? snapshot : trie;
      const records = await migrateCollectionMetadata(
        engine,
        collection,
      );
      console.log(
        `${scopeId}/${collection}: migrated bounded-read metadata for ${records} stored records`,
      );
    }
  } finally {
    clearMaterials(materials);
  }
}

export async function migrateCollectionMetadata(
  engine: MetadataMigrationEngine,
  collection: string,
): Promise<number> {
  const before = await engine.exportStored(collection);
  await engine.replaceStored(collection, before);
  const after = await engine.exportStored(collection);
  if (
    stableStringify(after as unknown as JsonValue) !==
    stableStringify(before as unknown as JsonValue)
  ) {
    throw new Error(
      `Collection ${collection} changed while migrating metadata`,
    );
  }
  return before.length;
}

if (isDirectExecution()) {
  await migrateMetadataFromEnvironment();
}

function configuredLayouts(): Record<string, CollectionLayout> {
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
  const writeVersion = positiveInteger(
    process.env.THIMBLE_KEY_VERSION,
    1,
  );
  const historical = (
    process.env.THIMBLE_READ_KEY_VERSIONS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => positiveInteger(value));
  return [
    writeVersion,
    ...historical.filter((value) => value !== writeVersion),
  ];
}

function positiveInteger(
  value: string | undefined,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
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

function clearMaterials(materials: ScopeMaterial[]): void {
  materials.forEach((material) => material.rawKey?.fill(0));
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry &&
      path.resolve(entry) ===
        path.resolve(fileURLToPath(import.meta.url)),
  );
}
