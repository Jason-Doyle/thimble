import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cli = path.resolve("bin", "thimbledb.mjs");

describe("ThimbleDB CLI", () => {
  it("creates a local web project without installing", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-cli-"),
    );
    const destination = path.join(root, "notes-app");
    try {
      const result = run([
        "create",
        destination,
        "--no-install",
      ]);
      expect(result.status).toBe(0);

      const packageJson = JSON.parse(
        await readFile(
          path.join(destination, "package.json"),
          "utf8",
        ),
      );
      expect(packageJson.name).toBe("notes-app");
      expect(packageJson.dependencies.thimbledb).toMatch(
        /^\^\d+\.\d+\.\d+$/,
      );
      expect(
        await readFile(
          path.join(destination, "server.mjs"),
          "utf8",
        ),
      ).toContain("THIMBLE_DEV_IDENTITY");

      const doctor = run(["doctor"], destination);
      expect(doctor.status).toBe(0);
      expect(doctor.stdout).toContain(
        "PASS ThimbleDB dependency",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a non-empty directory", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "thimbledb-cli-nonempty-"),
    );
    try {
      await writeFile(path.join(root, "existing.txt"), "keep");
      const result = run([
        "create",
        root,
        "--no-install",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Destination is not empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown commands", () => {
    const result = run(["unknown-command"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Unsupported ThimbleDB command",
    );
  });

  it("generates the Entra authorization manifest", () => {
    const result = run(["generate-entra-roles"]);
    expect(result.status).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(
      manifest.api.oauth2PermissionScopes[0].value,
    ).toBe("thimble.access");
    expect(manifest.appRoles).toHaveLength(4);
  });

});

function run(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}
