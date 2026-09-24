import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const rootPackage = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const workspace = await mkdtemp(
  path.join(os.tmpdir(), "thimbledb-package-"),
);
const consumer = path.join(workspace, "consumer");

try {
  const packed = run(
    [
      "pack",
      "--json",
      "--pack-destination",
      workspace,
    ],
    root,
  );
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(workspace, filename);

  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "thimbledb-package-verification",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        include: ["*.ts"],
      },
      null,
      2,
    )}\n`,
  );

  run(
    [
      "install",
      tarball,
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  );

  await assertMissing(
    path.join(consumer, "node_modules", "@aws-sdk", "client-s3"),
  );
  await assertMissing(
    path.join(consumer, "node_modules", "@azure", "storage-blob"),
  );
  await assertMissing(
    path.join(consumer, "node_modules", "@google-cloud", "firestore"),
  );
  await assertMissing(
    path.join(consumer, "node_modules", "pg"),
  );
  await assertPresent(
    path.join(
      consumer,
      "node_modules",
      "thimbledb",
      "bin",
      "thimbledb.mjs",
    ),
  );
  await assertPresent(
    path.join(
      consumer,
      "node_modules",
      "thimbledb",
      "templates",
      "local-web",
      "gitignore.template",
    ),
  );
  await assertPresent(
    path.join(
      consumer,
      "node_modules",
      "thimbledb",
      "dist",
      "package",
      "index-migrate.js",
    ),
  );
  await assertPresent(
    path.join(
      consumer,
      "node_modules",
      "thimbledb",
      "scripts",
      "generate-entra-roles.mjs",
    ),
  );
  runCliVersion(consumer, rootPackage.version);

  runNode(
    `
      const [core, auth, nodeAuthority, cloudflareAuthority, local, migration] =
        await Promise.all([
          import("thimbledb"),
          import("thimbledb/auth"),
          import("thimbledb/authority/node"),
          import("thimbledb/authority/cloudflare"),
          import("thimbledb/providers/local"),
          import("thimbledb/migration"),
        ]);
      if (
        !core.ThimbleClient ||
        !core.createThimbleClient ||
        !core.defineCollection ||
        !core.defineIndex ||
        !auth.AuthService ||
        !nodeAuthority.createNodeAuthorityServer ||
        !cloudflareAuthority.createCloudflareAuthority ||
        !local.LocalObjectStore ||
        !migration.createArchiveManifest
      ) {
        process.exit(1);
      }
    `,
    consumer,
  );
  await writeFile(
    path.join(consumer, "base.ts"),
    `
      import { ThimbleClient } from "thimbledb";
      import {
        createThimbleClient,
        defineCollection,
        defineIndex,
      } from "thimbledb";
      import { AuthService } from "thimbledb/auth";
      import { LocalObjectStore } from "thimbledb/providers/local";
      import { createArchiveManifest } from "thimbledb/migration";

      void [
        ThimbleClient,
        createThimbleClient,
        defineCollection,
        defineIndex,
        AuthService,
        LocalObjectStore,
        createArchiveManifest,
      ];
    `,
  );
  runTypeScript(consumer);
  run(
    [
      "install",
      "--save-dev",
      "@types/node",
      "@cloudflare/workers-types",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  );
  await assertMissing(
    path.join(consumer, "node_modules", "@aws-sdk", "client-s3"),
  );
  await assertMissing(
    path.join(consumer, "node_modules", "@azure", "storage-blob"),
  );
  await writeFile(
    path.join(consumer, "authorities.ts"),
    `
      import { createNodeAuthorityServer } from "thimbledb/authority/node";
      import authority from "thimbledb/authority/cloudflare";

      void [createNodeAuthorityServer, authority];
    `,
  );
  runTypeScript(consumer);

  for (const [provider, dependency] of [
    ["azure", "@azure/storage-blob"],
    ["s3", "@aws-sdk/client-s3"],
  ]) {
    runNode(
      `
        process.env.THIMBLE_PROVIDER = "${provider}";
        process.env.THIMBLE_ALLOWED_ORIGIN = "https://example.test";
        const { createNodeAuthorityServer } =
          await import("thimbledb/authority/node");
        try {
          await createNodeAuthorityServer();
          process.exit(1);
        } catch (error) {
          if (!String(error).includes("${dependency}")) {
            throw error;
          }
        }
      `,
      consumer,
    );
  }
  run(
    [
      "install",
      "@aws-sdk/client-s3",
      "@azure/storage-blob",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  );

  runNode(
    `
      const [azure, s3] = await Promise.all([
        import("thimbledb/providers/azure"),
        import("thimbledb/providers/s3"),
      ]);
      if (!azure.AzureBlobObjectStore || !s3.S3ObjectStore) {
        process.exit(1);
      }
    `,
    consumer,
  );
  await writeFile(
    path.join(consumer, "providers.ts"),
    `
      import { AzureBlobObjectStore } from "thimbledb/providers/azure";
      import { S3ObjectStore } from "thimbledb/providers/s3";

      void [AzureBlobObjectStore, S3ObjectStore];
    `,
  );
  runTypeScript(consumer);

  console.log("Verified lightweight and provider package exports.");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function run(args, cwd) {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`npm ${args.join(" ")} failed`);
  }
  return result;
}

function runNode(source, cwd) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error("Package runtime import verification failed");
  }
}

function runTypeScript(cwd) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      path.join(cwd, "tsconfig.json"),
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error("Package type declaration verification failed");
  }
}

async function assertMissing(target) {
  try {
    await access(target);
  } catch {
    return;
  }
  throw new Error(`Optional provider dependency was installed: ${target}`);
}

async function assertPresent(target) {
  try {
    await access(target);
  } catch {
    throw new Error(`Expected package file is missing: ${target}`);
  }
}

function runCliVersion(cwd, expectedVersion) {
  const cli = path.join(
    cwd,
    "node_modules",
    "thimbledb",
    "bin",
    "thimbledb.mjs",
  );
  const result = spawnSync(process.execPath, [cli, "--version"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (
    result.status !== 0 ||
    result.stdout.trim() !== expectedVersion
  ) {
    throw new Error("Package CLI version verification failed");
  }
  const migration = spawnSync(
    process.execPath,
    [cli, "rebuild-indexes"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    migration.status === 0 ||
    !migration.stderr.includes(
      "THIMBLE_MIGRATION_QUIESCENT=true",
    )
  ) {
    throw new Error("Package CLI index migration verification failed");
  }
  const roles = spawnSync(
    process.execPath,
    [cli, "generate-entra-roles"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (roles.status !== 0) {
    throw new Error("Package CLI role generation failed");
  }
  const manifest = JSON.parse(roles.stdout);
  if (
    manifest.api?.oauth2PermissionScopes?.[0]?.value !==
      "thimble.access" ||
    manifest.appRoles?.length !== 4
  ) {
    throw new Error("Package CLI role manifest is malformed");
  }
}
