#!/usr/bin/env node

import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const [command = "help", ...args] = process.argv.slice(2);

if (command === "create") {
  await createProject(args);
} else if (command === "doctor") {
  await doctor();
} else if (
  ["export", "import", "validate", "ingest", "emit"].includes(
    command,
  )
) {
  const migration = await import(
    "../dist/package/migration/node.js"
  ).catch((error) => {
    throw new Error(
      "Migration commands require the built or published ThimbleDB package",
      { cause: error },
    );
  });
  const result = await migration.runMigrationCommand(
    command,
    args,
    packageJson.version,
  );
  console.log(JSON.stringify(result, null, 2));
} else if (command === "rebuild-indexes") {
  const migration = await import(
    "../dist/package/index-migrate.js"
  ).catch(
    (error) => {
      throw new Error(
        "Index rebuilding requires the built or published ThimbleDB package",
        { cause: error },
      );
    },
  );
  await migration.rebuildIndexesFromEnvironment();
} else if (command === "generate-entra-roles") {
  const generator = await import(
    "../scripts/generate-entra-roles.mjs"
  ).catch((error) => {
    throw new Error(
      "Entra role generation requires the built or published ThimbleDB package",
      { cause: error },
    );
  });
  await generator.run(args);
} else if (command === "--version" || command === "version") {
  console.log(packageJson.version);
} else if (command === "help" || command === "--help") {
  printHelp();
} else {
  throw new Error(`Unsupported ThimbleDB command: ${command}`);
}

async function createProject(args) {
  const install = !args.includes("--no-install");
  const directoryArgument = args.find(
    (argument) => !argument.startsWith("--"),
  );
  if (!directoryArgument) {
    throw new Error(
      "Usage: thimbledb create <directory> [--no-install]",
    );
  }
  const destination = path.resolve(directoryArgument);
  await requireEmptyDestination(destination);
  const projectName = path.basename(destination);
  await mkdir(destination, { recursive: true });
  await cp(
    path.join(packageRoot, "templates", "local-web"),
    destination,
    { recursive: true },
  );
  await rename(
    path.join(destination, "gitignore.template"),
    path.join(destination, ".gitignore"),
  );
  await replaceTemplateValues(destination, {
    __PROJECT_NAME__: npmPackageName(projectName),
    __THIMBLE_VERSION__: packageJson.version,
  });

  console.log(`Created ${destination}`);
  if (install) {
    runNpm(["install", "--no-audit", "--no-fund"], destination);
  }
  console.log(`
Next steps:
  cd ${directoryArgument}
  ${install ? "" : "npm install\n  "}npm run dev

Open http://127.0.0.1:5173 and use the local development identity.
`);
}

async function doctor() {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js 22 or newer",
    ok: Number.isInteger(major) && major >= 22,
    value: process.version,
  });
  const currentPackagePath = path.resolve("package.json");
  let currentPackage = null;
  try {
    currentPackage = JSON.parse(
      await readFile(currentPackagePath, "utf8"),
    );
  } catch {
    checks.push({
      name: "Project package.json",
      ok: false,
      value: "not found",
    });
  }
  if (currentPackage) {
    checks.push({
      name: "Project package.json",
      ok: true,
      value: currentPackage.name ?? "unnamed",
    });
    checks.push({
      name: "ES modules",
      ok: currentPackage.type === "module",
      value: currentPackage.type ?? "not configured",
    });
    checks.push({
      name: "ThimbleDB dependency",
      ok: Boolean(
        currentPackage.dependencies?.thimbledb ??
          currentPackage.devDependencies?.thimbledb,
      ),
      value:
        currentPackage.dependencies?.thimbledb ??
        currentPackage.devDependencies?.thimbledb ??
        "not installed",
    });
  }
  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(
      `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.value}`,
    );
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function requireEmptyDestination(destination) {
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) {
      throw new Error(`Destination is not a directory: ${destination}`);
    }
    if ((await readdir(destination)).length > 0) {
      throw new Error(`Destination is not empty: ${destination}`);
    }
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
}

async function replaceTemplateValues(directory, replacements) {
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await replaceTemplateValues(entryPath, replacements);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    let content = await readFile(entryPath, "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      content = content.replaceAll(token, value);
    }
    await writeFile(entryPath, content);
  }
}

function runNpm(args, cwd) {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed`);
  }
}

function npmPackageName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "thimbledb-app";
}

function printHelp() {
  console.log(`
ThimbleDB ${packageJson.version}

  thimbledb create <directory> [--no-install]
  thimbledb doctor
  thimbledb export --scope <id> --collections <a,b> --out <directory>
  thimbledb validate --archive <directory>
  thimbledb import --archive <directory> [--mode create|replace|merge] [--dry-run]
  thimbledb ingest --from <json|csv|lowdb|sqlite|postgres|firestore> --scope <id> --collection <name> --out <archive>
  thimbledb emit --to <json|csv|lowdb|sqlite|postgres|firestore> --archive <directory> --scope <id> --collection <name>
  thimbledb rebuild-indexes
  thimbledb generate-entra-roles [--out <file>] [--force]
  thimbledb --version
`);
}
