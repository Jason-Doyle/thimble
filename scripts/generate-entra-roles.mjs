import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createEntraAuthorizationManifest(
  idFactory = randomUUID,
) {
  return {
    api: {
      oauth2PermissionScopes: [
        {
          adminConsentDescription:
            "Allow the application to create a ThimbleDB session.",
          adminConsentDisplayName: "Access ThimbleDB",
          id: idFactory(),
          isEnabled: true,
          type: "Admin",
          value: "thimble.access",
        },
      ],
    },
    appRoles: [
      role(
        idFactory(),
        "ThimbleDB user",
        "Create a normal ThimbleDB application session.",
        "thimble.user",
      ),
      role(
        idFactory(),
        "ThimbleDB administrator",
        "Use ThimbleDB identity and administration endpoints.",
        "thimble.admin",
      ),
      role(
        idFactory(),
        "ThimbleDB tenant writer",
        "Write documents in assigned ThimbleDB tenant scopes.",
        "thimble.tenant.writer",
      ),
      role(
        idFactory(),
        "ThimbleDB tenant administrator",
        "Write and administer assigned ThimbleDB tenant scopes.",
        "thimble.tenant.admin",
      ),
    ],
  };
}

export async function run(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    printHelp();
    return;
  }
  const output = option(args, "--out");
  const force = args.includes("--force");
  const unknown = args.filter(
    (argument, index) =>
      argument !== "--force" &&
      argument !== "--out" &&
      args[index - 1] !== "--out",
  );
  if (unknown.length > 0) {
    throw new Error(`Unexpected argument: ${unknown[0]}`);
  }
  const manifest = createEntraAuthorizationManifest();
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  process.stderr.write(
    "Merge this fragment with the existing application registration; do not replace unrelated roles or scopes.\n",
  );
  if (!output) {
    process.stdout.write(content);
    return;
  }
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, content, {
      encoding: "utf8",
      flag: force ? "w" : "wx",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(
        `Output already exists: ${destination}. Use --force to replace it.`,
        { cause: error },
      );
    }
    throw error;
  }
  console.log(`Created ${destination}`);
}

function role(id, displayName, description, value) {
  return {
    allowedMemberTypes: ["User", "Application"],
    description,
    displayName,
    id,
    isEnabled: true,
    value,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`
Generate a Microsoft Entra authorization manifest fragment:

  thimbledb generate-entra-roles
  thimbledb generate-entra-roles --out entra-authorization.json
  thimbledb generate-entra-roles --out entra-authorization.json --force

The generated IDs must remain stable after assignments are created.
Merge the fragment with the existing application registration.
`);
}

function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(
    entry &&
      path.resolve(entry) ===
        path.resolve(fileURLToPath(import.meta.url)),
  );
}

if (isDirectExecution()) {
  await run();
}
