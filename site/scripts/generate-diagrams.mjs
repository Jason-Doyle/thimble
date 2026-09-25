import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(siteRoot, "..");
const docsRoot = path.join(repositoryRoot, "docs");
const outputDirectory = path.join(siteRoot, "public", "diagrams");
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "thimbledb-diagrams-"),
);

try {
  const sourceFiles = (await walk(docsRoot)).filter((file) =>
    file.endsWith(".md"),
  );
  const diagrams = [];
  for (const file of sourceFiles) {
    diagrams.push(
      ...extractDiagrams(await readFile(file, "utf8")),
    );
  }
  await mkdir(outputDirectory, { recursive: true });
  const expectedFiles = new Set();

  for (const diagram of diagrams) {
    const hash = sourceHash(diagram);
    const fileName = `${hash}.svg`;
    expectedFiles.add(fileName);
    const inputPath = path.join(temporaryDirectory, `${hash}.mmd`);
    const outputPath = path.join(outputDirectory, fileName);
    await writeFile(inputPath, `${diagram}\n`, "utf8");
    runMermaid(inputPath, outputPath);
  }

  for (const entry of await readdir(outputDirectory, {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".svg") &&
      !expectedFiles.has(entry.name)
    ) {
      await unlink(path.join(outputDirectory, entry.name));
    }
  }

  /**
   * @param {string} directory
   * @returns {Promise<string[]>}
   */
  async function walk(directory) {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    /** @type {string[]} */
    const files = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(entryPath)));
      } else {
        files.push(entryPath);
      }
    }
    return files;
  }

  console.log(
    `Generated ${diagrams.length} static Mermaid diagrams.`,
  );
} finally {
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
  });
}

/**
 * @param {string} markdown
 * @returns {string[]}
 */
function extractDiagrams(markdown) {
  return [
    ...markdown.matchAll(
      /```mermaid\s*\r?\n([\s\S]*?)\r?\n```/g,
    ),
  ].map((match) => normalizeSource(match[1]));
}

/** @param {string} source */
function sourceHash(source) {
  return createHash("sha256")
    .update(normalizeSource(source))
    .digest("hex")
    .slice(0, 20);
}

/** @param {string} source */
function normalizeSource(source) {
  return source.replace(/\r\n/g, "\n").trim();
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 */
function runMermaid(inputPath, outputPath) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    executable,
    [
      "--yes",
      "@mermaid-js/mermaid-cli@12.0.0",
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--theme",
      "neutral",
      "--backgroundColor",
      "transparent",
      "--no-font-embed",
      "--quiet",
    ],
    {
      cwd: repositoryRoot,
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Mermaid rendering failed for ${path.basename(inputPath)}${result.error ? `: ${result.error.message}` : ""}`,
    );
  }
}
