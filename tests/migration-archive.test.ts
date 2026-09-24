import { describe, expect, it } from "vitest";
import {
  createArchiveCollection,
  createArchiveManifest,
  parseArchiveCollection,
  parseArchiveManifest,
  serializeArchiveManifest,
} from "../src/migration/archive.js";

describe("logical migration archive", () => {
  it("serializes documents deterministically with checksums", async () => {
    const archive = await createArchiveCollection(
      "notes",
      "collections/public--notes.ndjson",
      [
        {
          id: "note-2",
          title: "Second",
        },
        {
          id: "note-1",
          title: "First",
        },
      ],
      false,
    );

    expect(archive.ndjson).toBe(
      '{"id":"note-1","title":"First"}\n' +
        '{"id":"note-2","title":"Second"}\n',
    );
    await expect(
      parseArchiveCollection(
        archive.manifest,
        archive.ndjson,
      ),
    ).resolves.toHaveLength(2);
    await expect(
      parseArchiveCollection(
        archive.manifest,
        `${archive.ndjson} `,
      ),
    ).rejects.toThrow("checksum");
  });

  it("round-trips a versioned manifest", () => {
    const manifest = createArchiveManifest({
      packageVersion: "2.1.0",
      createdAt: new Date("2026-09-24T00:00:00.000Z"),
      scopes: [
        {
          scopeId: "public",
          collections: [
            {
              name: "notes",
              file: "collections/public--notes.ndjson",
              records: 1,
              sha256:
                "a".repeat(64),
              includesDeleted: false,
            },
          ],
        },
      ],
    });

    expect(
      parseArchiveManifest(
        JSON.parse(serializeArchiveManifest(manifest)),
      ),
    ).toEqual(manifest);
  });

  it("rejects unsafe archive paths", () => {
    expect(() =>
      parseArchiveManifest({
        format: "thimbledb-logical-archive",
        version: 1,
        createdAt: new Date().toISOString(),
        encryption: "none",
        source: {
          type: "thimbledb",
          packageVersion: "2.1.0",
        },
        scopes: [
          {
            scopeId: "public",
            collections: [
              {
                name: "notes",
                file: "../notes.ndjson",
                records: 0,
                sha256: "0".repeat(64),
                includesDeleted: false,
              },
            ],
          },
        ],
      }),
    ).toThrow("Archive collection is malformed");
  });

  it("rejects malformed retained tombstones", async () => {
    const archive = await createArchiveCollection(
      "notes",
      "collections/public--notes.ndjson",
      [
        {
          id: "note-1",
          __thimbleTombstone: {
            deletedAt: "invalid",
            restoreUntil: "2026-09-25T00:00:00.000Z",
            purgeAfter: "2026-10-02T00:00:00.000Z",
          },
          document: {
            id: "note-1",
            title: "Deleted",
          },
        },
      ],
      true,
    );

    await expect(
      parseArchiveCollection(
        archive.manifest,
        archive.ndjson,
      ),
    ).rejects.toThrow("invalid retention dates");
  });
});
