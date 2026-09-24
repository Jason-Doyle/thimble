import path from "node:path";
import type { ObjectStore } from "../core.js";
import { LocalObjectStore } from "../stores.js";

export type Provider = "local" | "azure" | "s3" | "r2";
export type ProviderStoreKind = "data" | "auth";

export function parseProvider(value: string): Provider {
  if (
    value === "local" ||
    value === "azure" ||
    value === "s3" ||
    value === "r2"
  ) {
    return value;
  }
  throw new Error(`Unsupported THIMBLE_PROVIDER: ${value}`);
}

export async function createConfiguredProviderStores(
  provider: Provider,
): Promise<{ data: ObjectStore; auth: ObjectStore }> {
  const [data, auth] = await Promise.all([
    createConfiguredProviderStore(provider, "data"),
    createConfiguredProviderStore(provider, "auth"),
  ]);
  return { data, auth };
}

export async function createConfiguredProviderStore(
  provider: Provider,
  kind: ProviderStoreKind,
): Promise<ObjectStore> {
  if (provider === "local") {
    const configuredRoot =
      kind === "data"
        ? process.env.THIMBLE_LOCAL_DATA_ROOT
        : process.env.THIMBLE_LOCAL_AUTH_ROOT;
    return new LocalObjectStore(
      path.resolve(
        configuredRoot ??
          (kind === "data" ? ".thimble-data" : ".thimble-auth"),
      ),
    );
  }

  if (provider === "azure") {
    const { AzureBlobObjectStore } = await loadAzureProvider();
    const dataContainer =
      process.env.AZURE_STORAGE_CONTAINER ?? "thimbledb";
    return new AzureBlobObjectStore(
      requiredEnvironment("AZURE_STORAGE_CONNECTION_STRING"),
      kind === "data"
        ? dataContainer
        : process.env.AZURE_AUTH_STORAGE_CONTAINER ??
            `${dataContainer}-auth`,
    );
  }

  const { S3ObjectStore } = await loadS3Provider();
  if (provider === "s3") {
    const clientConfig: {
      region: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    } = {
      region: process.env.AWS_REGION ?? "us-east-1",
    };
    if (process.env.S3_ENDPOINT) {
      clientConfig.endpoint = process.env.S3_ENDPOINT;
    }
    if (process.env.S3_FORCE_PATH_STYLE) {
      clientConfig.forcePathStyle =
        process.env.S3_FORCE_PATH_STYLE === "true";
    }
    return new S3ObjectStore({
      bucket: requiredEnvironment(
        kind === "data" ? "S3_BUCKET" : "S3_AUTH_BUCKET",
      ),
      clientConfig,
    });
  }

  const accountId = requiredEnvironment("R2_ACCOUNT_ID");
  return new S3ObjectStore({
    bucket: requiredEnvironment(
      kind === "data" ? "R2_BUCKET" : "R2_AUTH_BUCKET",
    ),
    clientConfig: {
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
      },
    },
  });
}

async function loadAzureProvider(): Promise<
  typeof import("./azure.js")
> {
  try {
    return await import("./azure.js");
  } catch (error) {
    throw optionalPeerError(
      error,
      "@azure/storage-blob",
      "azure",
    );
  }
}

async function loadS3Provider(): Promise<typeof import("./s3.js")> {
  try {
    return await import("./s3.js");
  } catch (error) {
    throw optionalPeerError(error, "@aws-sdk/client-s3", "s3 or r2");
  }
}

function optionalPeerError(
  error: unknown,
  packageName: string,
  provider: string,
): Error {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes(packageName)
  ) {
    return new Error(
      `The ${provider} provider requires ${packageName}. Install it with "npm install ${packageName}".`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
