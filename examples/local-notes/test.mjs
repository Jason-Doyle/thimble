import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImmutableSnapshotEngine } from "thimbledb";
import { LocalObjectStore } from "thimbledb/providers/local";

test("writes, reads, and scans local notes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "thimbledb-local-notes-"),
  );
  try {
    const database = new ImmutableSnapshotEngine(
      new LocalObjectStore(directory),
    );
    await database.put("notes", "note-1", {
      id: "note-1",
      title: "First note",
      body: "Local example",
    });

    assert.deepEqual(await database.get("notes", "note-1"), {
      id: "note-1",
      title: "First note",
      body: "Local example",
    });
    assert.equal((await database.scan("notes")).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
