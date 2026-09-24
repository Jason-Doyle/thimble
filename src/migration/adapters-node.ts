import type { JsonDocument } from "../core.js";
import { documentFromRecord } from "./adapters.js";

export type ExternalWriteMode = "create" | "replace" | "merge";

export async function recordsFromSqlite(options: {
  database: string;
  query: string;
  idField?: string;
}): Promise<JsonDocument[]> {
  const { DatabaseSync } = await loadSqlite();
  const database = new DatabaseSync(options.database, {
    open: true,
    readOnly: true,
  });
  try {
    return database
      .prepare(options.query)
      .all()
      .map((row, index) =>
        documentFromRecord(
          row,
          options.idField ?? "id",
          `SQLite row ${index + 1}`,
        ),
      );
  } finally {
    database.close();
  }
}

export async function recordsToSqlite(options: {
  database: string;
  table: string;
  records: JsonDocument[];
  scopeId: string;
  collection: string;
  mode?: ExternalWriteMode;
}): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  const table = sqlIdentifier(options.table);
  const database = new DatabaseSync(options.database);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        scope_id TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_json TEXT NOT NULL,
        PRIMARY KEY (scope_id, collection_name, document_id)
      )
    `);
    const mode = options.mode ?? "create";
    database.exec("BEGIN IMMEDIATE");
    try {
      const count = database
        .prepare(
          `SELECT COUNT(*) AS count FROM "${table}" WHERE scope_id = ? AND collection_name = ?`,
        )
        .get(options.scopeId, options.collection);
      if (
        mode === "create" &&
        Number(count?.count ?? 0) > 0
      ) {
        throw new Error(
          "SQLite create export requires an empty target",
        );
      }
      if (mode === "replace") {
        database
          .prepare(
            `DELETE FROM "${table}" WHERE scope_id = ? AND collection_name = ?`,
          )
          .run(options.scopeId, options.collection);
      }
      const write = database.prepare(
        mode === "create"
          ? `
              INSERT INTO "${table}" (
                scope_id,
                collection_name,
                document_id,
                document_json
              ) VALUES (?, ?, ?, ?)
            `
          : `
              INSERT INTO "${table}" (
                scope_id,
                collection_name,
                document_id,
                document_json
              ) VALUES (?, ?, ?, ?)
              ON CONFLICT(scope_id, collection_name, document_id)
              DO UPDATE SET document_json = excluded.document_json
            `,
      );
      for (const record of options.records) {
        write.run(
          options.scopeId,
          options.collection,
          record.id,
          JSON.stringify(record),
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function recordsFromPostgres(options: {
  connectionString: string;
  query: string;
  idField?: string;
}): Promise<JsonDocument[]> {
  const { Client } = await loadPostgres();
  const client = new Client({
    connectionString: options.connectionString,
  });
  await client.connect();
  try {
    const result = await client.query(options.query);
    return result.rows.map((row, index) =>
      documentFromRecord(
        row,
        options.idField ?? "id",
        `PostgreSQL row ${index + 1}`,
      ),
    );
  } finally {
    await client.end();
  }
}

export async function recordsToPostgres(options: {
  connectionString: string;
  table: string;
  records: JsonDocument[];
  scopeId: string;
  collection: string;
  mode?: ExternalWriteMode;
}): Promise<void> {
  const { Client } = await loadPostgres();
  const table = sqlIdentifier(options.table);
  const client = new Client({
    connectionString: options.connectionString,
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        scope_id TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_json JSONB NOT NULL,
        PRIMARY KEY (scope_id, collection_name, document_id)
      )
    `);
    const mode = options.mode ?? "create";
    await client.query("BEGIN");
    try {
      await client.query(
        `LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE`,
      );
      const existing = await client.query(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE scope_id = $1 AND collection_name = $2`,
        [options.scopeId, options.collection],
      );
      if (
        mode === "create" &&
        Number(existing.rows[0]?.count ?? 0) > 0
      ) {
        throw new Error(
          "PostgreSQL create export requires an empty target",
        );
      }
      if (mode === "replace") {
        await client.query(
          `DELETE FROM "${table}" WHERE scope_id = $1 AND collection_name = $2`,
          [options.scopeId, options.collection],
        );
      }
      for (const record of options.records) {
        await client.query(
          mode === "create"
            ? `
                INSERT INTO "${table}" (
                  scope_id,
                  collection_name,
                  document_id,
                  document_json
                ) VALUES ($1, $2, $3, $4::jsonb)
              `
            : `
                INSERT INTO "${table}" (
                  scope_id,
                  collection_name,
                  document_id,
                  document_json
                ) VALUES ($1, $2, $3, $4::jsonb)
                ON CONFLICT(scope_id, collection_name, document_id)
                DO UPDATE SET document_json = excluded.document_json
              `,
          [
            options.scopeId,
            options.collection,
            record.id,
            JSON.stringify(record),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

export async function recordsFromFirestore(options: {
  projectId?: string;
  collection: string;
  idField?: string;
}): Promise<JsonDocument[]> {
  const { Firestore } = await loadFirestore();
  const firestore = new Firestore({
    ...(options.projectId ? { projectId: options.projectId } : {}),
  });
  const snapshot = await firestore
    .collection(options.collection)
    .get();
  return snapshot.docs.map((document, index) =>
    documentFromRecord(
      {
        ...document.data(),
        [options.idField ?? "id"]: document.id,
      },
      options.idField ?? "id",
      `Firestore document ${index + 1}`,
    ),
  );
}

export async function recordsToFirestore(options: {
  projectId?: string;
  collection: string;
  records: JsonDocument[];
  mode?: ExternalWriteMode;
}): Promise<void> {
  const { Firestore } = await loadFirestore();
  const firestore = new Firestore({
    ...(options.projectId ? { projectId: options.projectId } : {}),
  });
  const collection = firestore.collection(options.collection);
  const mode = options.mode ?? "create";
  const existing = await collection.limit(1).get();
  if (mode === "create" && !existing.empty) {
    throw new Error(
      "Firestore create export requires an empty target collection",
    );
  }
  if (mode === "replace") {
    const snapshot = await collection.get();
    for (let offset = 0; offset < snapshot.docs.length; offset += 500) {
      const batch = firestore.batch();
      snapshot.docs
        .slice(offset, offset + 500)
        .forEach((document) => batch.delete(document.ref));
      await batch.commit();
    }
  }
  for (let offset = 0; offset < options.records.length; offset += 500) {
    const batch = firestore.batch();
    options.records
      .slice(offset, offset + 500)
      .forEach((record) => {
        const { id, ...data } = record;
        const reference = collection.doc(id);
        if (mode === "create") {
          batch.create(reference, data);
        } else {
          batch.set(reference, data);
        }
      });
    await batch.commit();
  }
}

async function loadPostgres(): Promise<{
  Client: new (options: {
    connectionString: string;
  }) => {
    connect(): Promise<void>;
    end(): Promise<void>;
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>;
  };
}> {
  try {
    const moduleName = "pg";
    return await import(moduleName);
  } catch (error) {
    if (isMissingPackage(error, "pg")) {
      throw new Error(
        'PostgreSQL migrations require "npm install pg"',
        { cause: error },
      );
    }
    throw error;
  }
}

async function loadSqlite(): Promise<{
  DatabaseSync: new (
    database: string,
    options?: {
      open?: boolean;
      readOnly?: boolean;
    },
  ) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      all(...values: unknown[]): Array<Record<string, unknown>>;
      get(...values: unknown[]): Record<string, unknown> | undefined;
      run(...values: unknown[]): unknown;
    };
  };
}> {
  const moduleName = "node:sqlite";
  return import(moduleName);
}

async function loadFirestore(): Promise<{
  Firestore: new (options: { projectId?: string }) => {
    collection(name: string): FirestoreCollection;
    batch(): FirestoreBatch;
  };
}> {
  try {
    const moduleName = "@google-cloud/firestore";
    return await import(moduleName);
  } catch (error) {
    if (isMissingPackage(error, "@google-cloud/firestore")) {
      throw new Error(
        'Firestore migrations require "npm install @google-cloud/firestore"',
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingPackage(
  error: unknown,
  packageName: string,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return (
    ((code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND") &&
      error.message.includes(packageName)) ||
    error.message.includes(
      `Could not resolve "${packageName}" imported by`,
    )
  );
}

type FirestoreDocument = {
  id: string;
  ref: unknown;
  data(): Record<string, unknown>;
};

type FirestoreSnapshot = {
  docs: FirestoreDocument[];
  empty: boolean;
};

type FirestoreCollection = {
  get(): Promise<FirestoreSnapshot>;
  limit(count: number): {
    get(): Promise<FirestoreSnapshot>;
  };
  doc(id: string): unknown;
};

type FirestoreBatch = {
  create(
    reference: unknown,
    data: Record<string, unknown>,
  ): void;
  delete(reference: unknown): void;
  set(
    reference: unknown,
    data: Record<string, unknown>,
  ): void;
  commit(): Promise<unknown>;
};

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return value;
}
