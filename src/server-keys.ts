import {
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  base64ToBytes,
  bytesToBase64,
  importAesGcmKey,
} from "./envelope.js";

export type ScopeMaterial = {
  scopeId: string;
  encrypted: boolean;
  keyId: string | null;
  key: CryptoKey | undefined;
  rawKey: Uint8Array | undefined;
  addressNode: (bytes: Uint8Array) => string;
};

export async function loadScopeMaterial(options: {
  scopeId: string;
  encrypted: boolean;
  keyVersion: number;
  local: boolean;
}): Promise<ScopeMaterial> {
  if (!options.encrypted) {
    return {
      scopeId: options.scopeId,
      encrypted: false,
      keyId: null,
      key: undefined,
      rawKey: undefined,
      addressNode: (bytes) =>
        createHmac("sha256", "thimbledb-public-address-v1")
          .update(bytes)
          .digest("hex"),
    };
  }

  const masterKey = await loadMasterKey(options.local);
  const version = `v${options.keyVersion}`;
  const rawKey = deriveKey(
    masterKey,
    `encryption:${options.scopeId}:${version}`,
  );
  const addressKey = deriveKey(
    masterKey,
    `address:${options.scopeId}:${version}`,
  );
  return {
    scopeId: options.scopeId,
    encrypted: true,
    keyId: `${options.scopeId}:${version}`,
    key: await importAesGcmKey(
      rawKey,
      ["encrypt", "decrypt"],
    ),
    rawKey,
    addressNode: (bytes) =>
      createHmac("sha256", addressKey)
        .update(bytes)
        .digest("hex"),
  };
}

export function scopeKeyResponse(material: ScopeMaterial): {
  scopeId: string;
  keyId: string;
  key: string;
  algorithm: "A256GCM";
} {
  if (!material.encrypted || !material.keyId || !material.rawKey) {
    throw new Error(`Scope ${material.scopeId} is not encrypted`);
  }
  return {
    scopeId: material.scopeId,
    keyId: material.keyId,
    key: bytesToBase64(material.rawKey),
    algorithm: "A256GCM",
  };
}

async function loadMasterKey(local: boolean): Promise<Uint8Array> {
  const configured = process.env.THIMBLE_MASTER_KEY;
  if (configured) {
    const bytes = base64ToBytes(configured);
    if (bytes.byteLength !== 32) {
      throw new Error(
        "THIMBLE_MASTER_KEY must be a base64-encoded 32-byte key",
      );
    }
    return bytes;
  }

  if (!local) {
    throw new Error(
      "THIMBLE_MASTER_KEY is required for encrypted cloud scopes",
    );
  }

  const keyPath = path.resolve(".thimble-data", "master.key");
  try {
    const existing = (await readFile(keyPath, "utf8")).trim();
    const bytes = base64ToBytes(existing);
    if (bytes.byteLength !== 32) {
      throw new Error("Local ThimbleDB master key is invalid");
    }
    return bytes;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  await mkdir(path.dirname(keyPath), { recursive: true });
  const created = new Uint8Array(randomBytes(32));
  try {
    await writeFile(keyPath, `${bytesToBase64(created)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return created;
  } catch (error) {
    if (!isExistingFile(error)) {
      throw error;
    }
    const existing = (await readFile(keyPath, "utf8")).trim();
    return base64ToBytes(existing);
  }
}

function deriveKey(
  masterKey: Uint8Array,
  info: string,
): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from("thimbledb-scope-v1"),
      Buffer.from(info),
      32,
    ),
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isExistingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
