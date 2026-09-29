import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.env.THIMBLE_CLIENT_WRITE_OUTPUT ??
    ".bench-data/client-assisted-trie-writes-regional",
);
const target = required("THIMBLE_BENCHMARK_TARGET")
  .replace(/\/+$/, "");
const token = required("THIMBLE_BENCHMARK_TOKEN");
const objectsRoot = path.join(root, "objects");
const files = await walk(objectsRoot);
let completed = 0;

for (let offset = 0; offset < files.length; offset += 12) {
  await Promise.all(
    files.slice(offset, offset + 12).map(upload),
  );
}
console.log(JSON.stringify({ objects: files.length }));

async function upload(file) {
  const relative = path
    .relative(objectsRoot, file)
    .split(path.sep)
    .join("/");
  const url = [
    target,
    "fixture",
    ...relative
      .split("/")
      .map(encodeURIComponent),
  ].join("/");
  const bytes = await readFile(file);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type":
            "application/octet-stream",
          "x-benchmark-token": token,
        },
        body: bytes,
      });
      if (!response.ok) {
        throw new Error(
          `${response.status}: ${await response.text()}`,
        );
      }
      completed += 1;
      if (
        completed === files.length ||
        completed % 1_000 === 0
      ) {
        console.log(
          `Uploaded ${completed}/${files.length}`,
        );
      }
      return;
    } catch (error) {
      if (attempt === 8) {
        throw error;
      }
      await delay(
        500 * 2 ** Math.min(attempt - 1, 4),
      );
    }
  }
}

async function walk(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(
      directory,
      entry.name,
    );
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}
