import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEntraAuthorizationManifest,
  run,
} from "../scripts/generate-entra-roles.mjs";

describe("Entra authorization manifest generator", () => {
  it("creates the required scope and stable role values", () => {
    let id = 0;
    const manifest = createEntraAuthorizationManifest(
      () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`,
    );

    expect(
      manifest.api.oauth2PermissionScopes.map(
        (scope) => scope.value,
      ),
    ).toEqual(["thimble.access"]);
    expect(manifest.appRoles.map((role) => role.value)).toEqual([
      "thimble.user",
      "thimble.admin",
      "thimble.tenant.writer",
      "thimble.tenant.admin",
    ]);
    expect(
      manifest.appRoles.every((role) =>
        role.allowedMemberTypes.includes("Application"),
      ),
    ).toBe(true);
  });

  it("writes once unless replacement is explicit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "thimble-entra-roles-"),
    );
    const output = path.join(directory, "roles.json");
    try {
      await run(["--out", output]);
      const manifest = JSON.parse(await readFile(output, "utf8"));
      expect(manifest.appRoles).toHaveLength(4);
      await expect(
        run(["--out", output]),
      ).rejects.toThrow("Output already exists");
      await expect(
        run(["--out", output, "--force"]),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
