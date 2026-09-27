import { chromium } from "playwright";

const target = required("TARGET_URL").replace(/\/+$/, "");
const token = required("BENCHMARK_RESULT_TOKEN");
const region = required("BENCHMARK_REGION");
const runId = required("BENCHMARK_RUN_ID");
const replicate = required("BENCHMARK_REPLICATE");

const browser = await chromium.launch({
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(900_000);
  await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      typeof window.runAdaptiveHeadBenchmark ===
      "function",
  );
  const result = await page.evaluate(
    async (options) =>
      window.runAdaptiveHeadBenchmark(options),
    {
      target,
      token,
      runId,
      region,
      replicate,
    },
  );
  const complete = {
    ...result,
    browserVersion: browser.version(),
  };
  const url = new URL("/regional-result", target);
  url.searchParams.set("run", runId);
  url.searchParams.set("region", region);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-benchmark-token": token,
    },
    body: JSON.stringify(complete),
  });
  if (!response.ok) {
    throw new Error(
      `Result upload failed with ${response.status}: ${await response.text()}`,
    );
  }
  console.log(JSON.stringify({
    stored: true,
    runId,
    replicate,
    region,
    colo: complete.colo,
    scenarios: complete.scenarios.length,
  }));
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
