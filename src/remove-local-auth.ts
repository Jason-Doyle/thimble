import path from "node:path";
import { removeLegacyLocalAuth } from "./auth/legacy-migration.js";
import type { ObjectStore } from "./core.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import {
  loadScopeMaterial,
} from "./server-keys.js";
import {
  AzureBlobObjectStore,
  LocalObjectStore,
  PrefixObjectStore,
  S3ObjectStore,
} from "./stores.js";

const provider = process.env.THIMBLE_PROVIDER ?? "local";
const material = await loadScopeMaterial({
  scopeId: "system-auth",
  encrypted: true,
  keyVersion: 1,
  local: provider === "local",
});
const store = new EnvelopeObjectStore(
  new PrefixObjectStore(createAuthStore(provider), "auth-v1"),
  {
    key: material.key!,
    keyId: material.keyId!,
    compression: "gzip",
    objectKeyPrefix: "auth-v1",
  },
);
const result = await removeLegacyLocalAuth(
  store,
  (value) =>
    material.addressNode(new TextEncoder().encode(value)),
);
console.log(JSON.stringify(result, null, 2));
material.rawKey?.fill(0);

function createAuthStore(name: string): ObjectStore {
  if (name === "local") {
    return new LocalObjectStore(
      path.resolve(
        process.env.THIMBLE_LOCAL_AUTH_ROOT ?? ".thimble-auth",
      ),
    );
  }
  if (name === "azure") {
    const dataContainer =
      process.env.AZURE_STORAGE_CONTAINER ?? "thimbledb";
    return new AzureBlobObjectStore(
      required("AZURE_STORAGE_CONNECTION_STRING"),
      process.env.AZURE_AUTH_STORAGE_CONTAINER ??
        `${dataContainer}-auth`,
    );
  }
  if (name === "s3") {
    return new S3ObjectStore({
      bucket: required("S3_AUTH_BUCKET"),
      clientConfig: {
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.S3_ENDPOINT
          ? { endpoint: process.env.S3_ENDPOINT }
          : {}),
        ...(process.env.S3_FORCE_PATH_STYLE
          ? {
              forcePathStyle:
                process.env.S3_FORCE_PATH_STYLE === "true",
            }
          : {}),
      },
    });
  }
  if (name === "r2") {
    return new S3ObjectStore({
      bucket: required("R2_AUTH_BUCKET"),
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
