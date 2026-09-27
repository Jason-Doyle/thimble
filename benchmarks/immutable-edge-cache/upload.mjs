import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.env.THIMBLE_EDGE_CACHE_REGIONAL_OUTPUT ??
    ".bench-data/immutable-edge-cache",
);
const target = required("THIMBLE_BENCHMARK_TARGET")
  .replace(/\/+$/, "");
const token = required("THIMBLE_BENCHMARK_TOKEN");
const concurrency = integerValue(
  process.env.THIMBLE_UPLOAD_CONCURRENCY,
  6,
  1,
  20,
);
const objectsRoot = path.join(root, "objects");
const files = await walk(objectsRoot);
let completed = 0;

for (
  let offset = 0;
  offset < files.length;
  offset += concurrency
) {
  await Promise.all(
    files
      .slice(offset, offset + concurrency)
      .map(upload),
  );
}

const inventoryResponse = await fetch(
  `${target}/fixture-inventory`,
  {
    headers: {
      "x-benchmark-token": token,
    },
  },
);
if (!inventoryResponse.ok) {
  throw new Error(
    `Fixture inventory failed with ${inventoryResponse.status}`,
  );
}
const inventory = await inventoryResponse.json();
if (inventory.objects !== files.length) {
  throw new Error(
    `Fixture inventory contains ${inventory.objects} objects, expected ${files.length}`,
  );
}
console.log(JSON.stringify(inventory, null, 2));

async function upload(file) {
  const relative = path.relative(
    objectsRoot,
    file,
  ).split(path.sep).join("/");
  const url = [
    target,
    "fixture",
    ...relative.split("/").map(encodeURIComponent),
  ].join("/");
  const bytes = await readFile(file);
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-benchmark-token": token,
        },
        body: bytes,
      });
      if (!response.ok) {
        throw new Error(
          `Upload returned ${response.status}: ${await response.text()}`,
        );
      }
      completed += 1;
      if (
        completed === files.length ||
        completed % 25 === 0
      ) {
        console.log(
          `Uploaded ${completed}/${files.length}`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await delay(250 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

async function walk(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
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

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerValue(value, fallback, minimum, maximum) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `Upload concurrency must be ${minimum}-${maximum}`,
    );
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}
