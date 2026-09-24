import {
  lstat,
  mkdir,
  realpath,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  JsonDocument,
  JsonValue,
  ObjectStore,
} from "../core.js";
import { ContentAddressedTrieEngine } from "../engines/content-trie.js";
import { ImmutableSnapshotEngine } from "../engines/immutable-snapshot.js";
import { EnvelopeObjectStore } from "../envelope-store.js";
import { PrefixObjectStore } from "../prefix-store.js";
import {
  createConfiguredProviderStore,
  parseProvider,
  type Provider,
} from "../providers/configured.js";
import {
  loadScopeMaterial,
  type ScopeMaterial,
} from "../server-keys.js";
import {
  parseIndexConfiguration,
  type CollectionIndexConfiguration,
} from "../secondary-index.js";
import {
  createDictionary,
  stableStringify,
} from "../shared-utils.js";
import type { CollectionLayout } from "../snapshot-protocol.js";
import {
  scopeStoragePrefix,
  type TrieStoredDocument,
} from "../trie-protocol.js";
import {
  createArchiveCollection,
  createArchiveManifest,
  parseArchiveCollection,
  parseArchiveManifest,
  serializeArchiveManifest,
  type ThimbleArchiveManifest,
} from "./archive.js";
import {
  recordsFromCsv,
  recordsFromJson,
  recordsFromLowdb,
  recordsToCsv,
  recordsToJson,
} from "./adapters.js";
import {
  recordsFromFirestore,
  recordsFromPostgres,
  recordsFromSqlite,
  recordsToFirestore,
  recordsToPostgres,
  recordsToSqlite,
} from "./adapters-node.js";
import { isTrieTombstone } from "../trie-protocol.js";

export type MigrationCommandResult = {
  command:
    | "export"
    | "import"
    | "validate"
    | "ingest"
    | "emit";
  archive: string;
  scopes: number;
  collections: number;
  records: number;
  dryRun?: boolean;
  mode?: "create" | "replace" | "merge";
};

type Engine =
  | ContentAddressedTrieEngine
  | ImmutableSnapshotEngine;

export async function runMigrationCommand(
  command: string,
  args: string[],
  packageVersion: string,
): Promise<MigrationCommandResult> {
  const options = parseArgs(args);
  if (command === "export") {
    return exportArchive(options, packageVersion);
  }
  if (command === "validate") {
    return validateArchive(requiredOption(options, "archive"));
  }
  if (command === "import") {
    return importArchive(options);
  }
  if (command === "ingest") {
    return ingestExternal(options, packageVersion);
  }
  if (command === "emit") {
    return emitExternal(options);
  }
  throw new Error(`Unsupported migration command: ${command}`);
}

async function ingestExternal(
  options: ParsedArgs,
  packageVersion: string,
): Promise<MigrationCommandResult> {
  const source = requiredOption(options, "from");
  const scopeId = requiredOption(options, "scope");
  const collection = requiredOption(options, "collection");
  const idField = options.values.get("id-field") ?? "id";
  const dataPath = options.values.get("path");
  const projectId = options.values.get("project-id");
  let records: JsonDocument[];
  if (source === "json" || source === "lowdb") {
    const value = JSON.parse(
      await readFile(requiredOption(options, "input"), "utf8"),
    );
    records =
      source === "lowdb"
        ? recordsFromLowdb(
            value,
            requiredOption(options, "path"),
            idField,
          )
        : recordsFromJson(value, {
            ...(dataPath ? { path: dataPath } : {}),
            idField,
          });
  } else if (source === "csv") {
    records = recordsFromCsv(
      await readFile(requiredOption(options, "input"), "utf8"),
      idField,
    );
  } else if (source === "sqlite") {
    records = await recordsFromSqlite({
      database: requiredOption(options, "input"),
      query: requiredOption(options, "query"),
      idField,
    });
  } else if (source === "postgres") {
    records = await recordsFromPostgres({
      connectionString: connectionString(options),
      query: requiredOption(options, "query"),
      idField,
    });
  } else if (source === "firestore") {
    records = await recordsFromFirestore({
      ...(projectId ? { projectId } : {}),
      collection:
        options.values.get("source-collection") ?? collection,
      idField,
    });
  } else {
    throw new Error(`Unsupported migration source: ${source}`);
  }
  const destination = path.resolve(requiredOption(options, "out"));
  await writeSingleCollectionArchive({
    destination,
    packageVersion,
    scopeId,
    collection,
    records,
  });
  return {
    command: "ingest",
    archive: destination,
    scopes: 1,
    collections: 1,
    records: records.length,
  };
}

async function emitExternal(
  options: ParsedArgs,
): Promise<MigrationCommandResult> {
  const destinationType = requiredOption(options, "to");
  const archive = path.resolve(requiredOption(options, "archive"));
  const scopeId = requiredOption(options, "scope");
  const collectionName = requiredOption(options, "collection");
  const loaded = await readArchive(archive);
  const records = loaded.collections.get(
    archiveCollectionKey(scopeId, collectionName),
  );
  if (!records) {
    throw new Error(
      `Archive does not contain ${scopeId}/${collectionName}`,
    );
  }
  if (records.some(isTrieTombstone)) {
    throw new Error(
      "External emit does not accept retained tombstones; export live documents instead",
    );
  }
  const documents = records as JsonDocument[];
  const mode = migrationMode(options.values.get("mode"));
  const projectId = options.values.get("project-id");
  if (
    destinationType === "json" ||
    destinationType === "csv" ||
    destinationType === "lowdb"
  ) {
    const destination = path.resolve(requiredOption(options, "out"));
    if (!options.flags.has("force")) {
      await requireMissing(destination);
    }
    let content: string;
    if (destinationType === "csv") {
      content = recordsToCsv(documents);
    } else if (destinationType === "lowdb") {
      const dataPath = requiredOption(options, "path");
      content = `${JSON.stringify(
        objectAtPath(dataPath, documents),
        null,
        2,
      )}\n`;
    } else {
      content = recordsToJson(documents);
    }
    await writeFile(destination, content, "utf8");
  } else if (destinationType === "sqlite") {
    await recordsToSqlite({
      database: requiredOption(options, "out"),
      table: options.values.get("table") ?? "thimbledb_documents",
      records: documents,
      scopeId,
      collection: collectionName,
      mode,
    });
  } else if (destinationType === "postgres") {
    await recordsToPostgres({
      connectionString: connectionString(options),
      table: options.values.get("table") ?? "thimbledb_documents",
      records: documents,
      scopeId,
      collection: collectionName,
      mode,
    });
  } else if (destinationType === "firestore") {
    await recordsToFirestore({
      ...(projectId ? { projectId } : {}),
      collection:
        options.values.get("target-collection") ?? collectionName,
      records: documents,
      mode,
    });
  } else {
    throw new Error(
      `Unsupported migration destination: ${destinationType}`,
    );
  }
  return {
    command: "emit",
    archive,
    scopes: 1,
    collections: 1,
    records: records.length,
    mode,
  };
}

async function exportArchive(
  options: ParsedArgs,
  packageVersion: string,
): Promise<MigrationCommandResult> {
  const scopeId = requiredOption(options, "scope");
  const collections = requiredOption(options, "collections")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (collections.length === 0) {
    throw new Error("At least one collection is required");
  }
  if (new Set(collections).size !== collections.length) {
    throw new Error("Export collections must be unique");
  }
  const destination = path.resolve(requiredOption(options, "out"));
  await requireMissing(destination);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const includesDeleted = options.flags.has("include-deleted");
  const runtime = await createRuntime(scopeId);
  try {
    await mkdir(path.join(temporary, "collections"), {
      recursive: true,
    });
    const archiveCollections = [];
    let recordCount = 0;
    for (const collection of collections) {
      const engine = runtime.engine(collection);
      const records = includesDeleted
        ? await engine.exportStored(collection)
        : ((await engine.scan(collection)) as TrieStoredDocument[]);
      const file =
        `collections/${encodeURIComponent(scopeId)}` +
        `--${encodeURIComponent(collection)}.ndjson`;
      const archive = await createArchiveCollection(
        collection,
        file,
        records,
        includesDeleted,
      );
      await writeFile(
        path.join(temporary, file),
        archive.ndjson,
        "utf8",
      );
      archiveCollections.push(archive.manifest);
      recordCount += records.length;
    }
    const manifest = createArchiveManifest({
      packageVersion,
      scopes: [
        {
          scopeId,
          collections: archiveCollections,
        },
      ],
    });
    await writeFile(
      path.join(temporary, "manifest.json"),
      serializeArchiveManifest(manifest),
      "utf8",
    );
    await rename(temporary, destination);
    return {
      command: "export",
      archive: destination,
      scopes: 1,
      collections: collections.length,
      records: recordCount,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    runtime.dispose();
  }
}

async function validateArchive(
  archivePath: string,
): Promise<MigrationCommandResult> {
  const archive = path.resolve(archivePath);
  const { manifest, records } = await readArchive(archive);
  return {
    command: "validate",
    archive,
    scopes: manifest.scopes.length,
    collections: manifest.scopes.reduce(
      (total, scope) => total + scope.collections.length,
      0,
    ),
    records,
  };
}

async function importArchive(
  options: ParsedArgs,
): Promise<MigrationCommandResult> {
  const archive = path.resolve(requiredOption(options, "archive"));
  const mode = migrationMode(options.values.get("mode"));
  const dryRun = options.flags.has("dry-run");
  if (
    !dryRun &&
    process.env.THIMBLE_MIGRATION_QUIESCENT !== "true"
  ) {
    throw new Error(
      "Set THIMBLE_MIGRATION_QUIESCENT=true only after writes are blocked",
    );
  }
  const { manifest, collections, records } =
    await readArchive(archive);
  const runtimes = new Map<string, Awaited<ReturnType<typeof createRuntime>>>();
  try {
    const plans: Array<{
      scopeId: string;
      collection: string;
      engine: Engine;
      expected: TrieStoredDocument[];
    }> = [];
    for (const scope of manifest.scopes) {
      const runtime =
        runtimes.get(scope.scopeId) ??
        (await createRuntime(scope.scopeId));
      runtimes.set(scope.scopeId, runtime);
      for (const collection of scope.collections) {
        const source = collections.get(
          archiveCollectionKey(scope.scopeId, collection.name),
        )!;
        const engine = runtime.engine(collection.name);
        const current = await engine.exportStored(collection.name);
        const expected = importRecords(mode, current, source);
        plans.push({
          scopeId: scope.scopeId,
          collection: collection.name,
          engine,
          expected,
        });
      }
    }
    if (!dryRun) {
      for (const plan of plans) {
        await plan.engine.replaceStored(
          plan.collection,
          plan.expected,
        );
        const verified = await plan.engine.exportStored(
          plan.collection,
        );
        if (
          stableStringify(verified as unknown as JsonValue) !==
          stableStringify(plan.expected as unknown as JsonValue)
        ) {
          throw new Error(
            `Imported collection verification failed for ${plan.scopeId}/${plan.collection}`,
          );
        }
      }
    }
    return {
      command: "import",
      archive,
      scopes: manifest.scopes.length,
      collections: manifest.scopes.reduce(
        (total, scope) => total + scope.collections.length,
        0,
      ),
      records,
      dryRun,
      mode,
    };
  } finally {
    runtimes.forEach((runtime) => runtime.dispose());
  }
}

async function readArchive(archive: string): Promise<{
  manifest: ThimbleArchiveManifest;
  collections: Map<string, TrieStoredDocument[]>;
  records: number;
}> {
  const archiveRoot = await realpath(archive);
  const manifestPath = path.join(archiveRoot, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("Archive manifest must be a regular file");
  }
  const manifest = parseArchiveManifest(
    JSON.parse(
      await readFile(manifestPath, "utf8"),
    ),
  );
  const collections = new Map<string, TrieStoredDocument[]>();
  let records = 0;
  for (const scope of manifest.scopes) {
    for (const collection of scope.collections) {
      const file = path.resolve(archiveRoot, collection.file);
      if (!isWithinDirectory(archiveRoot, file)) {
        throw new Error("Archive collection path escapes its directory");
      }
      const fileInfo = await lstat(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
        throw new Error("Archive collection must be a regular file");
      }
      const resolvedFile = await realpath(file);
      if (!isWithinDirectory(archiveRoot, resolvedFile)) {
        throw new Error("Archive collection path escapes its directory");
      }

      const parsed = await parseArchiveCollection(
        collection,
        await readFile(resolvedFile, "utf8"),
      );
      collections.set(
        archiveCollectionKey(scope.scopeId, collection.name),
        parsed,
      );
      records += parsed.length;
    }
  }
  return { manifest, collections, records };
}

async function writeSingleCollectionArchive(options: {
  destination: string;
  packageVersion: string;
  scopeId: string;
  collection: string;
  records: JsonDocument[];
}): Promise<void> {
  await requireMissing(options.destination);
  const temporary = `${options.destination}.tmp-${randomUUID()}`;
  try {
    await mkdir(path.join(temporary, "collections"), {
      recursive: true,
    });
    const file =
      `collections/${encodeURIComponent(options.scopeId)}` +
      `--${encodeURIComponent(options.collection)}.ndjson`;
    const archive = await createArchiveCollection(
      options.collection,
      file,
      options.records,
      false,
    );
    await writeFile(
      path.join(temporary, file),
      archive.ndjson,
      "utf8",
    );
    const manifest = createArchiveManifest({
      packageVersion: options.packageVersion,
      scopes: [
        {
          scopeId: options.scopeId,
          collections: [archive.manifest],
        },
      ],
    });
    await writeFile(
      path.join(temporary, "manifest.json"),
      serializeArchiveManifest(manifest),
      "utf8",
    );
    await rename(temporary, options.destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function importRecords(
  mode: "create" | "replace" | "merge",
  current: TrieStoredDocument[],
  source: TrieStoredDocument[],
): TrieStoredDocument[] {
  if (mode === "create") {
    if (current.length > 0) {
      throw new Error(
        "Create import requires an empty target collection",
      );
    }
    return source;
  }
  if (mode === "replace") {
    return source;
  }
  const merged = new Map(current.map((record) => [record.id, record]));
  source.forEach((record) => merged.set(record.id, record));
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

async function createRuntime(scopeId: string): Promise<{
  engine(collection: string): Engine;
  dispose(): void;
}> {
  const provider = parseProvider(
    process.env.THIMBLE_PROVIDER ?? "local",
  );
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
    const rootStore = new PrefixObjectStore(
      await createConfiguredProviderStore(provider, "data"),
      prefix,
    );
    const scopedStore = new PrefixObjectStore(rootStore, scopePrefix);
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
    return {
      engine(collection) {
        return layouts[collection] === "snapshot"
          ? snapshot
          : trie;
      },
      dispose() {
        clearMaterials(materials);
      },
    };
  } catch (error) {
    clearMaterials(materials);
    throw error;
  }
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

type ParsedArgs = {
  values: Map<string, string>;
  flags: Set<string>;
};

function parseArgs(args: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (["dry-run", "include-deleted", "force"].includes(name)) {
      flags.add(name);
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function connectionString(options: ParsedArgs): string {
  const environmentName =
    options.values.get("connection-env") ?? "DATABASE_URL";
  const value = process.env[environmentName];
  if (!value) {
    throw new Error(`${environmentName} is required`);
  }
  return value;
}

function objectAtPath(
  dataPath: string,
  value: JsonDocument[],
): Record<string, unknown> {
  const segments = dataPath.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("lowdb emit requires a data path");
  }
  const root = Object.create(null) as Record<string, unknown>;
  let current = root;
  segments.forEach((segment, index) => {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
      throw new Error(`Invalid lowdb path segment: ${segment}`);
    }
    if (index === segments.length - 1) {
      current[segment] = value;
    } else {
      const next = Object.create(null) as Record<string, unknown>;
      current[segment] = next;
      current = next;
    }
  });
  return root;
}

function requiredOption(options: ParsedArgs, name: string): string {
  const value = options.values.get(name);
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function migrationMode(
  value: string | undefined,
): "create" | "replace" | "merge" {
  if (!value || value === "create") {
    return "create";
  }
  if (value === "replace" || value === "merge") {
    return value;
  }
  throw new Error(`Unsupported import mode: ${value}`);
}

function archiveCollectionKey(
  scopeId: string,
  collection: string,
): string {
  return `${scopeId}\0${collection}`;
}

async function requireMissing(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Archive destination already exists: ${target}`);
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
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

function clearMaterials(materials: ScopeMaterial[]): void {
  materials.forEach((material) => material.rawKey?.fill(0));
}
