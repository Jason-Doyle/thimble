import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  recordsFromCsv,
  recordsFromJson,
  recordsFromLowdb,
  recordsToCsv,
  recordsToJson,
} from "../src/migration/adapters.js";
import {
  recordsFromFirestore,
  recordsFromPostgres,
  recordsFromSqlite,
  recordsToSqlite,
} from "../src/migration/adapters-node.js";
import { runMigrationCommand } from "../src/migration/node.js";

describe("migration adapters", () => {
  it("converts JSON, lowdb, and CSV records", () => {
    const records = recordsFromJson([
      { id: 1, title: "First" },
      { id: 2, title: "Second" },
    ]);
    expect(records.map((record) => record.id)).toEqual(["1", "2"]);
    expect(
      recordsFromLowdb({ data: { notes: records } }, "data.notes"),
    ).toEqual(records);

    const csv = recordsToCsv(records);
    expect(recordsFromCsv(csv)).toEqual(records);
    expect(JSON.parse(recordsToJson(records))).toEqual(records);
  });

  it("round-trips the lossless SQLite document table", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-sqlite-"),
    );
    const database = path.join(directory, "notes.sqlite");
    try {
      await recordsToSqlite({
        database,
        table: "documents",
        scopeId: "user:1",
        collection: "notes",
        records: [
          {
            id: "note-1",
            title: "SQLite",
          },
        ],
      });
      const records = await recordsFromSqlite({
        database,
        query: `
          SELECT
            document_id AS id,
            json_extract(document_json, '$.title') AS title
          FROM documents
        `,
      });
      expect(records).toEqual([
        {
          id: "note-1",
          title: "SQLite",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ingests JSON and emits lowdb through the archive", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-adapter-cli-"),
    );
    const input = path.join(directory, "notes.json");
    const archive = path.join(directory, "archive");
    const output = path.join(directory, "lowdb.json");
    try {
      await writeFile(
        input,
        JSON.stringify([
          { id: "note-1", title: "Imported" },
        ]),
      );
      await runMigrationCommand(
        "ingest",
        [
          "--from",
          "json",
          "--input",
          input,
          "--scope",
          "public",
          "--collection",
          "notes",
          "--out",
          archive,
        ],
        "2.1.0",
      );
      await runMigrationCommand(
        "emit",
        [
          "--to",
          "lowdb",
          "--archive",
          archive,
          "--scope",
          "public",
          "--collection",
          "notes",
          "--path",
          "data.notes",
          "--out",
          output,
        ],
        "2.1.0",
      );
      expect(
        JSON.parse(await readFile(output, "utf8")),
      ).toEqual({
        data: {
          notes: [
            {
              id: "note-1",
              title: "Imported",
            },
          ],
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports missing optional cloud adapters", async () => {
    await expect(
      recordsFromPostgres({
        connectionString: "postgres://unused",
        query: "SELECT 1",
      }),
    ).rejects.toThrow('npm install pg');
    await expect(
      recordsFromFirestore({
        collection: "notes",
      }),
    ).rejects.toThrow("npm install @google-cloud/firestore");
  });

  it("rejects values that cannot round-trip as JSON", () => {
    expect(() =>
      recordsFromJson([
        {
          id: "note-1",
          score: Number.POSITIVE_INFINITY,
        },
      ]),
    ).toThrow("non-finite number");

    expect(() =>
      recordsFromJson([
        {
          id: "note-1",
          createdAt: new Date(),
        },
      ]),
    ).toThrow("plain JSON object");

    expect(() =>
      recordsFromJson(
        [
          {
            sourceId: "source-1",
            id: "different",
          },
        ],
        { idField: "sourceId" },
      ),
    ).toThrow("conflicts with sourceId");
  });
});
