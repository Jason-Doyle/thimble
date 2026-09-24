import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EnvelopeObjectStore } from "../src/envelope-store.js";
import { ImmutableSnapshotEngine } from "../src/engines/immutable-snapshot.js";
import { runMigrationCommand } from "../src/migration/node.js";
import { PrefixObjectStore } from "../src/prefix-store.js";
import { LocalObjectStore } from "../src/providers/local.js";
import { scopeStoragePrefix } from "../src/trie-protocol.js";

describe("logical migration commands", () => {
  it("exports, validates, dry-runs, and imports a collection", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-migration-"),
    );
    const archive = path.join(root, "archive");
    const previous = captureEnvironment([
      "THIMBLE_PROVIDER",
      "THIMBLE_LOCAL_DATA_ROOT",
      "THIMBLE_PREFIX",
      "THIMBLE_COLLECTION_LAYOUTS",
      "THIMBLE_MIGRATION_QUIESCENT",
    ]);
    try {
      process.env.THIMBLE_PROVIDER = "local";
      process.env.THIMBLE_LOCAL_DATA_ROOT =
        path.join(root, "objects");
      process.env.THIMBLE_PREFIX = "source";
      process.env.THIMBLE_COLLECTION_LAYOUTS =
        "notes=snapshot";

      const source = await publicSnapshot(
        process.env.THIMBLE_LOCAL_DATA_ROOT,
        "source",
      );
      await source.putMany("notes", [
        {
          id: "note-1",
          title: "First",
        },
        {
          id: "note-2",
          title: "Second",
        },
      ]);

      const exported = await runMigrationCommand(
        "export",
        [
          "--scope",
          "public",
          "--collections",
          "notes",
          "--out",
          archive,
        ],
        "2.1.0",
      );
      expect(exported.records).toBe(2);
      await expect(
        runMigrationCommand(
          "validate",
          ["--archive", archive],
          "2.1.0",
        ),
      ).resolves.toMatchObject({
        command: "validate",
        records: 2,
      });

      process.env.THIMBLE_PREFIX = "target";
      await expect(
        runMigrationCommand(
          "import",
          ["--archive", archive, "--dry-run"],
          "2.1.0",
        ),
      ).resolves.toMatchObject({
        dryRun: true,
        mode: "create",
      });

      process.env.THIMBLE_MIGRATION_QUIESCENT = "true";
      await runMigrationCommand(
        "import",
        ["--archive", archive],
        "2.1.0",
      );
      const target = await publicSnapshot(
        process.env.THIMBLE_LOCAL_DATA_ROOT,
        "target",
      );
      await expect(target.scan("notes")).resolves.toEqual([
        {
          id: "note-1",
          title: "First",
        },
        {
          id: "note-2",
          title: "Second",
        },
      ]);
    } finally {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights every create target before writing", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-migration-preflight-"),
    );
    const archive = path.join(root, "archive");
    const previous = captureEnvironment([
      "THIMBLE_PROVIDER",
      "THIMBLE_LOCAL_DATA_ROOT",
      "THIMBLE_PREFIX",
      "THIMBLE_COLLECTION_LAYOUTS",
      "THIMBLE_MIGRATION_QUIESCENT",
    ]);
    try {
      process.env.THIMBLE_PROVIDER = "local";
      process.env.THIMBLE_LOCAL_DATA_ROOT =
        path.join(root, "objects");
      process.env.THIMBLE_PREFIX = "source";
      process.env.THIMBLE_COLLECTION_LAYOUTS =
        "notes=snapshot,settings=snapshot";

      const source = await publicSnapshot(
        process.env.THIMBLE_LOCAL_DATA_ROOT,
        "source",
      );
      await source.put("notes", "note-1", {
        id: "note-1",
        title: "First",
      });
      await source.put("settings", "settings-1", {
        id: "settings-1",
        theme: "dark",
      });
      await runMigrationCommand(
        "export",
        [
          "--scope",
          "public",
          "--collections",
          "notes,settings",
          "--out",
          archive,
        ],
        "2.1.0",
      );

      process.env.THIMBLE_PREFIX = "target";
      process.env.THIMBLE_MIGRATION_QUIESCENT = "true";
      const target = await publicSnapshot(
        process.env.THIMBLE_LOCAL_DATA_ROOT,
        "target",
      );
      await target.put("settings", "existing", {
        id: "existing",
        theme: "light",
      });

      await expect(
        runMigrationCommand(
          "import",
          ["--archive", archive, "--mode", "create"],
          "2.1.0",
        ),
      ).rejects.toThrow("requires an empty target collection");
      await expect(target.scan("notes")).resolves.toEqual([]);
      await expect(target.scan("settings")).resolves.toEqual([
        {
          id: "existing",
          theme: "light",
        },
      ]);
    } finally {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function publicSnapshot(
  root: string,
  prefix: string,
): Promise<ImmutableSnapshotEngine> {
  const scopePrefix = scopeStoragePrefix("public");
  const store = new EnvelopeObjectStore(
    new PrefixObjectStore(
      new PrefixObjectStore(
        new LocalObjectStore(root),
        prefix,
      ),
      scopePrefix,
    ),
    {
      compression: "gzip",
      objectKeyPrefix: scopePrefix,
    },
  );
  return new ImmutableSnapshotEngine(store);
}

function captureEnvironment(names: string[]) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(
  previous: Map<string, string | undefined>,
) {
  for (const [name, value] of previous) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
