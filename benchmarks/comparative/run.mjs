import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runScenario } from "./scenario.mjs";
import {
  createAdapter as createSqlite,
} from "./adapters/sqlite.mjs";
import {
  createAdapter as createThimble,
} from "./adapters/thimbledb-local.mjs";

const results = [];
for (const create of [createThimble, createSqlite]) {
  results.push(await runScenario(await create()));
}

const output = {
  generatedAt: new Date().toISOString(),
  warning:
    "Local harness evidence only. These adapters exercise different architectures and do not establish production superiority.",
  results,
};
await mkdir("benchmark-results", { recursive: true });
const outputPath = path.resolve(
  "benchmark-results",
  `comparative-${Date.now()}.json`,
);
await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
console.log(`Raw result: ${outputPath}`);
