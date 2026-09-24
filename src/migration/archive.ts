import type {
  JsonValue,
} from "../core.js";
import {
  isTrieTombstone,
  type TrieStoredDocument,
} from "../trie-protocol.js";
import {
  stableStringify,
  validateName,
} from "../shared-utils.js";

export const THIMBLE_ARCHIVE_FORMAT =
  "thimbledb-logical-archive";
export const THIMBLE_ARCHIVE_VERSION = 1;

export type ArchiveCollection = {
  name: string;
  file: string;
  records: number;
  sha256: string;
  includesDeleted: boolean;
};

export type ArchiveScope = {
  scopeId: string;
  collections: ArchiveCollection[];
};

export type ThimbleArchiveManifest = {
  format: typeof THIMBLE_ARCHIVE_FORMAT;
  version: typeof THIMBLE_ARCHIVE_VERSION;
  createdAt: string;
  encryption: "none";
  source: {
    type: "thimbledb";
    packageVersion: string;
  };
  scopes: ArchiveScope[];
};

export async function createArchiveCollection(
  name: string,
  file: string,
  records: TrieStoredDocument[],
  includesDeleted: boolean,
): Promise<{
  manifest: ArchiveCollection;
  ndjson: string;
}> {
  const normalizedName = validateName(name, "Collection");
  const ordered = [...records].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  assertUniqueIds(ordered);
  const ndjson =
    ordered
      .map((record) =>
        stableStringify(record as unknown as JsonValue),
      )
      .join("\n") + (ordered.length > 0 ? "\n" : "");
  return {
    manifest: {
      name: normalizedName,
      file,
      records: ordered.length,
      sha256: await sha256(ndjson),
      includesDeleted,
    },
    ndjson,
  };
}

export function createArchiveManifest(options: {
  packageVersion: string;
  scopes: ArchiveScope[];
  createdAt?: Date;
}): ThimbleArchiveManifest {
  return {
    format: THIMBLE_ARCHIVE_FORMAT,
    version: THIMBLE_ARCHIVE_VERSION,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    encryption: "none",
    source: {
      type: "thimbledb",
      packageVersion: options.packageVersion,
    },
    scopes: options.scopes.map((scope) => ({
      scopeId: scope.scopeId,
      collections: [...scope.collections].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    })),
  };
}

export function parseArchiveManifest(
  value: unknown,
): ThimbleArchiveManifest {
  if (
    !isRecord(value) ||
    value.format !== THIMBLE_ARCHIVE_FORMAT ||
    value.version !== THIMBLE_ARCHIVE_VERSION ||
    value.encryption !== "none" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(value.source) ||
    value.source.type !== "thimbledb" ||
    typeof value.source.packageVersion !== "string" ||
    value.source.packageVersion.length === 0 ||
    !Array.isArray(value.scopes)
  ) {
    throw new Error("Archive manifest is malformed");
  }
  const scopeIds = new Set<string>();
  const files = new Set<string>();
  const scopes = value.scopes.map((scope) => {
    if (
      !isRecord(scope) ||
      typeof scope.scopeId !== "string" ||
      scope.scopeId.length === 0 ||
      !Array.isArray(scope.collections) ||
      scopeIds.has(scope.scopeId)
    ) {
      throw new Error("Archive scope is malformed");
    }
    scopeIds.add(scope.scopeId);
    const collections = new Set<string>();
    return {
      scopeId: scope.scopeId,
      collections: scope.collections.map((collection) => {
        if (
          !isRecord(collection) ||
          typeof collection.name !== "string" ||
          collection.name.length === 0 ||
          typeof collection.file !== "string" ||
          !safeArchiveFile(collection.file) ||
          files.has(collection.file) ||
          typeof collection.records !== "number" ||
          !Number.isInteger(collection.records) ||
          collection.records < 0 ||
          typeof collection.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(collection.sha256) ||
          typeof collection.includesDeleted !== "boolean" ||
          collections.has(collection.name)
        ) {
          throw new Error("Archive collection is malformed");
        }
        const name = validateName(
          collection.name,
          "Collection",
        );
        collections.add(name);
        files.add(collection.file);
        return {
          name,
          file: collection.file,
          records: collection.records,
          sha256: collection.sha256,
          includesDeleted: collection.includesDeleted,
        };
      }),
    };
  });
  return {
    format: THIMBLE_ARCHIVE_FORMAT,
    version: THIMBLE_ARCHIVE_VERSION,
    createdAt: value.createdAt,
    encryption: "none",
    source: {
      type: "thimbledb",
      packageVersion: value.source.packageVersion,
    },
    scopes,
  };
}

export async function parseArchiveCollection(
  collection: ArchiveCollection,
  ndjson: string,
): Promise<TrieStoredDocument[]> {
  if ((await sha256(ndjson)) !== collection.sha256) {
    throw new Error(
      `Archive checksum does not match for ${collection.name}`,
    );
  }
  const records = ndjson
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Archive record ${index + 1} in ${collection.name} is not valid JSON`,
          { cause: error },
        );
      }
      if (
        !isRecord(parsed) ||
        typeof parsed.id !== "string"
      ) {
        throw new Error(
          `Archive record ${index + 1} in ${collection.name} is malformed`,
        );
      }
      if (Object.hasOwn(parsed, "__thimbleTombstone")) {
        if (!collection.includesDeleted) {
          throw new Error(
            `Archive collection ${collection.name} contains undeclared tombstones`,
          );
        }
        validateTombstone(
          parsed,
          collection.name,
          index + 1,
        );
      }
      return parsed as unknown as TrieStoredDocument;
    });
  if (records.length !== collection.records) {
    throw new Error(
      `Archive record count does not match for ${collection.name}`,
    );
  }
  assertUniqueIds(records);
  if (
    !collection.includesDeleted &&
    records.some(isTrieTombstone)
  ) {
    throw new Error(
      `Archive collection ${collection.name} contains deleted records`,
    );
  }
  return records;
}

export function serializeArchiveManifest(
  manifest: ThimbleArchiveManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertUniqueIds(records: TrieStoredDocument[]): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new Error(`Duplicate archive document id: ${record.id}`);
    }
    ids.add(record.id);
  }
}

function safeArchiveFile(value: string): boolean {
  return (
    /^collections\/[A-Za-z0-9%._-]+\.ndjson$/.test(value) &&
    !value.includes("..")
  );
}

function validateTombstone(
  value: Record<string, unknown>,
  collection: string,
  recordNumber: number,
): void {
  const tombstone = value.__thimbleTombstone;
  const document = value.document;
  if (
    !isRecord(tombstone) ||
    typeof tombstone.deletedAt !== "string" ||
    typeof tombstone.restoreUntil !== "string" ||
    typeof tombstone.purgeAfter !== "string" ||
    !isRecord(document) ||
    typeof document.id !== "string" ||
    document.id !== value.id
  ) {
    throw new Error(
      `Archive tombstone ${recordNumber} in ${collection} is malformed`,
    );
  }
  const deletedAt = Date.parse(tombstone.deletedAt);
  const restoreUntil = Date.parse(tombstone.restoreUntil);
  const purgeAfter = Date.parse(tombstone.purgeAfter);
  if (
    !Number.isFinite(deletedAt) ||
    !Number.isFinite(restoreUntil) ||
    !Number.isFinite(purgeAfter) ||
    deletedAt > restoreUntil ||
    restoreUntil > purgeAfter
  ) {
    throw new Error(
      `Archive tombstone ${recordNumber} in ${collection} has invalid retention dates`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
