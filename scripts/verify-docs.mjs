import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsRoot = path.join(root, "docs");
const markdownFiles = [
  path.join(root, "README.md"),
  path.join(root, "CHANGELOG.md"),
  ...walk(docsRoot).filter((file) => file.endsWith(".md")),
];
const errors = [];
const anchorCache = new Map();

for (const file of markdownFiles) {
  const content = readFileSync(file, "utf8");
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const fences = content
    .split(/\r?\n/)
    .filter((line) => line.startsWith("```")).length;
  if (fences % 2 !== 0) {
    errors.push(`${relative}: unbalanced fenced code blocks`);
  }
  if (
    relative.startsWith("docs/use-cases/") &&
    content.includes("ThimbleDB 1.x")
  ) {
    errors.push(`${relative}: stale ThimbleDB 1.x prompt`);
  }
  if (relative !== "README.md" && relative !== "docs/README.md") {
    const headings = withoutFencedCode(content).match(/^# .+$/gm) ?? [];
    if (headings.length !== 1) {
      errors.push(
        `${relative}: expected one level-one heading, found ${headings.length}`,
      );
    }
  }
  for (const match of content.matchAll(
    /\[[^\]]*]\(([^)]+)\)/g,
  )) {
    const raw = match[1].trim();
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) {
      continue;
    }
    const hashIndex = raw.indexOf("#");
    const target =
      hashIndex === -1 ? raw : raw.slice(0, hashIndex);
    const fragment =
      hashIndex === -1 ? "" : raw.slice(hashIndex + 1);
    const decoded = decodeURIComponent(
      target.replace(/^<|>$/g, ""),
    );
    const resolved = decoded
      ? path.resolve(path.dirname(file), decoded)
      : file;
    if (!existsSync(resolved)) {
      errors.push(`${relative}: missing link target ${raw}`);
      continue;
    }
    if (
      fragment &&
      resolved.toLowerCase().endsWith(".md") &&
      !markdownAnchors(resolved).has(
        decodeURIComponent(fragment).toLowerCase(),
      )
    ) {
      errors.push(`${relative}: missing link anchor ${raw}`);
    }
  }
}

const docsIndex = readFileSync(
  path.join(docsRoot, "README.md"),
  "utf8",
);
for (const file of readdirSync(docsRoot, {
  withFileTypes: true,
})) {
  if (
    file.isFile() &&
    file.name.endsWith(".md") &&
    !["README.md"].includes(file.name) &&
    !docsIndex.includes(`](${file.name})`)
  ) {
    errors.push(`docs/README.md: missing ${file.name}`);
  }
}

const metadataSource = readFileSync(
  path.join(root, "site", "src", "data", "docs.ts"),
  "utf8",
);
const metadataIds = [
  ...metadataSource.matchAll(/\bid:\s*"([^"]+)"/g),
].map((match) => match[1]);
const metadataTitles = new Map(
  [
    ...metadataSource.matchAll(
      /\{\s*id:\s*"([^"]+)",\s*title:\s*"([^"]+)"/g,
    ),
  ].map((match) => [match[1], match[2]]),
);
const duplicateIds = metadataIds.filter(
  (id, index) => metadataIds.indexOf(id) !== index,
);
duplicateIds.forEach((id) =>
  errors.push(`site docs metadata: duplicate id ${id}`),
);

const expectedIds = walk(docsRoot)
  .filter((file) => file.endsWith(".md"))
  .map((file) =>
    path.relative(docsRoot, file).replaceAll("\\", "/"),
  )
  .filter(
    (file) =>
      file !== "README.md" && file !== "NPM-PUBLISHING.md",
  )
  .map(documentId);
expectedIds.push("changelog");
for (const id of expectedIds) {
  if (!metadataIds.includes(id)) {
    errors.push(`site docs metadata: missing id ${id}`);
  }
}
for (const id of metadataIds) {
  if (!expectedIds.includes(id)) {
    errors.push(`site docs metadata: no source for ${id}`);
  }
}
for (const file of walk(docsRoot).filter(
  (candidate) =>
    candidate.endsWith(".md") &&
    !candidate.endsWith(`${path.sep}README.md`) &&
    !candidate.endsWith(`${path.sep}NPM-PUBLISHING.md`),
)) {
  const id = documentId(
    path.relative(docsRoot, file).replaceAll("\\", "/"),
  );
  const heading = /^# (.+)$/m.exec(
    withoutFencedCode(readFileSync(file, "utf8")),
  )?.[1];
  if (metadataTitles.get(id) !== heading) {
    errors.push(
      `site docs metadata: title for ${id} does not match "${heading ?? "missing"}"`,
    );
  }
}
if (metadataTitles.get("changelog") !== "Changelog") {
  errors.push(
    'site docs metadata: title for changelog does not match "Changelog"',
  );
}

const packageJson = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
if (!packageJson.files?.includes("docs")) {
  errors.push("package.json: complete docs directory is not packaged");
}
if (packageJson.homepage !== "https://thimbledb.com") {
  errors.push("package.json: homepage is not https://thimbledb.com");
}

const changelog = readFileSync(
  path.join(root, "CHANGELOG.md"),
  "utf8",
);
const firstRelease =
  /^## (\d+\.\d+\.\d+)(?:\s+-\s+.*)?$/m.exec(
    changelog,
  )?.[1];
if (firstRelease !== packageJson.version) {
  errors.push(
    `CHANGELOG.md: first release ${firstRelease ?? "missing"} does not match ${packageJson.version}`,
  );
}

const configuration = readFileSync(
  path.join(docsRoot, "CONFIGURATION.md"),
  "utf8",
);
const sourceFiles = walk(path.join(root, "src")).filter((file) =>
  file.endsWith(".ts"),
);
const configuredNames = new Set();
for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  for (const pattern of [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /required(?:Environment)?\("([A-Z][A-Z0-9_]+)"\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      configuredNames.add(match[1]);
    }
  }
}
const workerSource = readFileSync(
  path.join(root, "src", "cloudflare-worker.ts"),
  "utf8",
);
const workerEnvironment =
  /export type CloudflareAuthorityEnv = \{([\s\S]*?)^};/m.exec(
    workerSource,
  )?.[1] ?? "";
for (const match of workerEnvironment.matchAll(
  /^\s{2}([A-Z][A-Z0-9_]+)\??:/gm,
)) {
  configuredNames.add(match[1]);
}
configuredNames.delete("AWS_LAMBDA_FUNCTION_NAME");
for (const name of configuredNames) {
  if (!configuration.includes(`\`${name}\``)) {
    errors.push(`docs/CONFIGURATION.md: missing ${name}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `Verified ${markdownFiles.length} Markdown files and ${metadataIds.length} website document routes.`,
);

function walk(directory) {
  return readdirSync(directory, {
    withFileTypes: true,
  }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function documentId(file) {
  const withoutExtension = file.replace(/\.md$/i, "");
  if (withoutExtension.startsWith("use-cases/")) {
    return `use-cases/${path.posix
      .basename(withoutExtension)
      .toLowerCase()}`;
  }

  if (withoutExtension.startsWith("compare/")) {
    return `compare/${path.posix
      .basename(withoutExtension)
      .toLowerCase()}`;
  }
  const special = {
    "USE-CASES": "use-cases",
    COMPARISONS: "comparisons",
    "VIBE-CODED-APPS": "vibe-coded-apps",
    FAQ: "faq",
    BENCHMARKS: "benchmarks",
    SECURITY: "security",
  };
  return special[withoutExtension] ?? withoutExtension.toLowerCase();
}

function withoutFencedCode(content) {
  let fenced = false;
  return content
    .split(/\r?\n/)
    .filter((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n");
}

function markdownAnchors(file) {
  const cached = anchorCache.get(file);
  if (cached) {
    return cached;
  }
  const anchors = new Set();
  const duplicateCounts = new Map();
  const content = withoutFencedCode(readFileSync(file, "utf8"));
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    const count = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}
