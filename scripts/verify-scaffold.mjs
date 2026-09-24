import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const root = process.cwd();
const workspace = await mkdtemp(
  path.join(os.tmpdir(), "thimbledb-scaffold-"),
);
const cliHost = path.join(workspace, "cli");
const project = path.join(workspace, "notes-app");
const processes = [];
const diagnostics = [];

try {
  const packed = runNpm(
    ["pack", "--json", "--pack-destination", workspace],
    root,
  );
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(workspace, filename);
  await mkdir(cliHost);
  await writeFile(
    path.join(cliHost, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  runNpm(
    [
      "install",
      tarball,
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
    ],
    cliHost,
  );
  runNode(
    [
      path.join(
        cliHost,
        "node_modules",
        "thimbledb",
        "bin",
        "thimbledb.mjs",
      ),
      "create",
      project,
      "--no-install",
    ],
    cliHost,
  );
  const gitignore = await readFile(
    path.join(project, ".gitignore"),
    "utf8",
  );
  if (
    !gitignore.includes(".thimble-data/") ||
    !gitignore.includes(".thimble-auth/")
  ) {
    throw new Error(
      "Generated application does not protect local secrets",
    );
  }
  const packagePath = path.join(project, "package.json");
  const projectPackage = JSON.parse(
    await readFile(packagePath, "utf8"),
  );
  projectPackage.dependencies.thimbledb = `file:${tarball}`;
  await writeFile(
    packagePath,
    `${JSON.stringify(projectPackage, null, 2)}\n`,
  );
  runNpm(["install", "--no-audit", "--no-fund"], project);
  runNpm(["run", "build"], project);

  processes.push(
    captureProcess(spawn(process.execPath, ["server.mjs"], {
      cwd: project,
      stdio: "pipe",
    }), "authority"),
    captureProcess(spawn(
      process.execPath,
      [
        path.join(
          project,
          "node_modules",
          "vite",
          "bin",
          "vite.js",
        ),
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: project,
        stdio: "pipe",
      },
    ), "web"),
  );
  await waitForUrl("http://127.0.0.1:5173/");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") {
        diagnostics.push(`browser console: ${message.text()}\n`);
      }
    });
    page.on("pageerror", (error) => {
      diagnostics.push(`browser error: ${String(error)}\n`);
    });
    await page.goto("http://127.0.0.1:5173/", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Notes" }).waitFor();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Indexed note");
    await page.getByLabel("Body").fill("Generated starter");
    await page.getByRole("button", { name: "Add note" }).click();
    await page
      .getByRole("heading", { name: "Indexed note" })
      .waitFor();
    await page.getByLabel("Indexed title lookup").fill(
      "Indexed note",
    );
    await page.getByRole("button", { name: "Find" }).click();
    await page.getByText("1 notes via index by-title").waitFor();
    await page.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("button", {
        name: "Restore last deleted note",
      })
      .click();
    await page.getByText("Indexed note").waitFor();
  } finally {
    await browser.close();
  }
  console.log("Verified generated ThimbleDB web application.");
} catch (error) {
  process.stderr.write(diagnostics.join(""));
  throw error;
} finally {
  await Promise.all(processes.map(stopProcess));
  await removeWithRetry(workspace);
}

function captureProcess(child, name) {
  child.stdout?.on("data", (chunk) => {
    diagnostics.push(`${name}: ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    diagnostics.push(`${name}: ${chunk}`);
  });
  return child;
}

function runNpm(args, cwd) {
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

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`node ${args.join(" ")} failed`);
  }
}

async function waitForUrl(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function removeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, 250 * (attempt + 1)),
      );
    }
  }
  throw lastError;
}
