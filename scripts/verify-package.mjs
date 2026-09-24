import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
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

  runNode(
    `
      const [core, auth, nodeAuthority, cloudflareAuthority, local] =
        await Promise.all([
          import("thimbledb"),
          import("thimbledb/auth"),
          import("thimbledb/authority/node"),
          import("thimbledb/authority/cloudflare"),
          import("thimbledb/providers/local"),
        ]);
      if (
        !core.ThimbleClient ||
        !auth.AuthService ||
        !nodeAuthority.createNodeAuthorityServer ||
        !cloudflareAuthority.createCloudflareAuthority ||
        !local.LocalObjectStore
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
      import { AuthService } from "thimbledb/auth";
      import { createNodeAuthorityServer } from "thimbledb/authority/node";
      import authority from "thimbledb/authority/cloudflare";
      import { LocalObjectStore } from "thimbledb/providers/local";

      void [
        ThimbleClient,
        AuthService,
        createNodeAuthorityServer,
        authority,
        LocalObjectStore,
      ];
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
