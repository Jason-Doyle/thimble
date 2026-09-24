import { DatabaseSync } from "node:sqlite";

export async function createAdapter() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      last_modified INTEGER NOT NULL
    );
    CREATE INDEX notes_title ON notes(title);
  `);
  const insert = database.prepare(`
    INSERT INTO notes (id, title, body, last_modified)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      last_modified = excluded.last_modified
  `);
  return {
    name: "sqlite-memory",
    environment:
      "Node built-in SQLite in-memory database without network access",
    seed(documents) {
      database.exec("BEGIN");
      try {
        documents.forEach((document) =>
          insert.run(
            document.id,
            document.title,
            document.body,
            document.lastModified,
          ),
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    get(id) {
      return Promise.resolve(
        database.prepare("SELECT * FROM notes WHERE id = ?").get(id),
      );
    },
    findByTitle(title) {
      return Promise.resolve(
        database
          .prepare("SELECT * FROM notes WHERE title = ?")
          .all(title),
      );
    },
    scan() {
      return Promise.resolve(
        database.prepare("SELECT * FROM notes ORDER BY id").all(),
      );
    },
    put(document) {
      insert.run(
        document.id,
        document.title,
        document.body,
        document.lastModified,
      );
      return Promise.resolve();
    },
    close() {
      database.close();
      return Promise.resolve();
    },
  };
}
