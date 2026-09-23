import path from "node:path";
import type { JsonValue, ObjectStore } from "./core.js";
import { ContentAddressedTrieEngine } from "./engines/content-trie.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import { PrefixObjectStore } from "./prefix-store.js";
import {
  loadScopeMaterial,
  type ScopeMaterial,
} from "./server-keys.js";
import {
  AzureBlobObjectStore,
  LocalObjectStore,
  S3ObjectStore,
} from "./stores.js";
import {
  scopeStoragePrefix,
  trieHeadKey,
} from "./trie-protocol.js";
import { stableStringify } from "./shared-utils.js";

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
  createProviderStore(provider),
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
const engine = new ContentAddressedTrieEngine(
  store,
  40,
  writeMaterial.addressNode,
);
const verificationEngine = new ContentAddressedTrieEngine(
  new EnvelopeObjectStore(rawScopeStore, {
    key: writeMaterial.key!,
    keyId: writeMaterial.keyId!,
    compression: "gzip",
    objectKeyPrefix: scopePrefix,
  }),
  40,
  writeMaterial.addressNode,
);

for (const collection of collections) {
  const expectedHead =
    await store.get(trieHeadKey(collection));
  const documents = await engine.scan(collection);
  if (!expectedHead && documents.length === 0) {
    console.log(`${collection}: no live collection to migrate`);
    continue;
  }
  const rewritten = await engine.rewriteIfHeadUnchanged(
    collection,
    documents,
    expectedHead?.etag ?? null,
  );
  if (!rewritten) {
    throw new Error(
      `Collection ${collection} changed during migration; no HEAD update was committed`,
    );
  }
  const verified = await verificationEngine.scan(collection);
  if (
    stableStringify(verified as unknown as JsonValue) !==
    stableStringify(documents as unknown as JsonValue)
  ) {
    throw new Error(
      `Collection ${collection} content changed during verification`,
    );
  }
  console.log(
    `${collection}: rewrote ${documents.length} documents to ${writeMaterial.keyId}`,
  );
}

materials.forEach((material: ScopeMaterial) =>
  material.rawKey?.fill(0),
);

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
