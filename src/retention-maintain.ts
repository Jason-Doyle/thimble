import path from "node:path";
import type { ObjectStore } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { ImmutableSnapshotEngine } from "./engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import { PrefixObjectStore } from "./prefix-store.js";
import { loadScopeMaterial } from "./server-keys.js";
import type { CollectionLayout } from "./snapshot-protocol.js";
import {
  AzureBlobObjectStore,
  LocalObjectStore,
  S3ObjectStore,
} from "./stores.js";
import { scopeStoragePrefix } from "./trie-protocol.js";

if (process.env.THIMBLE_MAINTENANCE_QUIESCENT !== "true") {
  throw new Error(
    "Set THIMBLE_MAINTENANCE_QUIESCENT=true only after all authorities are in maintenance mode",
  );
}

const provider = process.env.THIMBLE_PROVIDER ?? "local";
const scopeId = required("THIMBLE_SCOPE_ID");
const collections = required("THIMBLE_COLLECTIONS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const prefix = process.env.THIMBLE_PREFIX ?? "demo";
const materials = await Promise.all(
  configuredVersions().map((keyVersion) =>
    loadScopeMaterial({
      scopeId,
      encrypted: true,
      keyVersion,
      local: provider === "local",
    }),
  ),
);
const writeMaterial = materials[0]!;
const scopePrefix = scopeStoragePrefix(scopeId);
const store = new EnvelopeObjectStore(
  new PrefixObjectStore(
    new PrefixObjectStore(createProviderStore(provider), prefix),
    scopePrefix,
  ),
  {
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
  },
);
const trie = new ContentAddressedTrieEngine(
  store,
  40,
  writeMaterial.addressNode,
  true,
);
const snapshot = new ImmutableSnapshotEngine(
  store,
  40,
  writeMaterial.addressNode,
  true,
);
const layouts = collectionLayouts();
const retiredLayouts = collectionLayouts(
  process.env.THIMBLE_RETIRED_COLLECTION_LAYOUTS,
);

for (const collection of collections) {
  const layout = layouts[collection] ?? "trie";
  const engine = layout === "snapshot" ? snapshot : trie;
  const purged = await engine.purgeDeleted(collection);
  await engine.compact(collection);
  const retiredLayout = retiredLayouts[collection];
  const dropped =
    retiredLayout && retiredLayout !== layout
      ? await (retiredLayout === "snapshot"
          ? snapshot
          : trie
        ).dropCollection(collection)
      : 0;
  console.log(
    `${scopeId}/${collection}: purged ${purged} expired tombstones, collected unreachable ${layout} objects, and dropped ${dropped} retired-layout objects`,
  );
}
materials.forEach((material) => material.rawKey?.fill(0));

function collectionLayouts(
  configured = process.env.THIMBLE_COLLECTION_LAYOUTS,
): Record<string, CollectionLayout> {
  const layouts: Record<string, CollectionLayout> = {};
  for (const entry of (
    configured ?? ""
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

function createProviderStore(name: string): ObjectStore {
  if (name === "local") {
    return new LocalObjectStore(path.resolve(".thimble-data"));
  }
  if (name === "azure") {
    return new AzureBlobObjectStore(
      required("AZURE_STORAGE_CONNECTION_STRING"),
      process.env.AZURE_STORAGE_CONTAINER ?? "thimbledb",
    );
  }
  if (name === "s3") {
    return new S3ObjectStore({
      bucket: required("S3_BUCKET"),
      clientConfig: {
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.S3_ENDPOINT
          ? { endpoint: process.env.S3_ENDPOINT }
          : {}),
      },
    });
  }
  if (name === "r2") {
    return new S3ObjectStore({
      bucket: required("R2_BUCKET"),
      clientConfig: {
        region: "auto",
        endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: required("R2_ACCESS_KEY_ID"),
          secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
        },
      },
    });
  }
  throw new Error(`Unsupported THIMBLE_PROVIDER: ${name}`);
}

function configuredVersions(): number[] {
  const writeVersion = positiveInteger(
    process.env.THIMBLE_KEY_VERSION,
    1,
  );
  return [
    writeVersion,
    ...(process.env.THIMBLE_READ_KEY_VERSIONS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => positiveInteger(value, writeVersion))
      .filter((value) => value !== writeVersion),
  ];
}

function positiveInteger(
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
