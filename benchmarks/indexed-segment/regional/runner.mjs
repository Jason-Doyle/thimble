import { chromium } from "playwright";

const target = required("TARGET_URL");
const region = required("BENCHMARK_REGION");
const pointIterations = numberValue(
  process.env.POINT_ITERATIONS,
  24,
);
const queryIterations = numberValue(
  process.env.QUERY_ITERATIONS,
  8,
);
const scanIterations = numberValue(
  process.env.SCAN_ITERATIONS,
  4,
);

const browser = await chromium.launch({
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(target, {
    waitUntil: "networkidle",
    timeout: 120_000,
  });
  await page.waitForFunction(
    () => window.benchmarkReady === true,
    undefined,
    { timeout: 120_000 },
  );
  const result = await page.evaluate(
    async (options) =>
      window.runRegionalBenchmark(options),
    {
      region,
      pointIterations,
      queryIterations,
      scanIterations,
    },
  );
  console.log(`THIMBLE_RESULT=${JSON.stringify(result)}`);
} finally {
  await browser.close();
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function numberValue(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Iteration count must be 1-100");
  }
  return parsed;
}
