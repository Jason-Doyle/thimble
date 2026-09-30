import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const date = "2026-09-29";
const regionalPath = path.resolve(
  "evidence",
  `client-assisted-trie-writes-regional-worker-${date}.json`,
);
const localSource =
  process.env.THIMBLE_CLIENT_WRITE_LOCAL_RESULT ??
  await latestLocalResult();
const localPath = path.resolve(
  "evidence",
  `client-assisted-trie-writes-local-${date}.json`,
);
const csvPath = path.resolve(
  "evidence",
  `client-assisted-trie-writes-summary-${date}.csv`,
);
const graphPath = path.resolve(
  "benchmarks",
  "client-assisted-trie-writes",
  "client-assisted-trie-writes-p50.svg",
);

await mkdir(path.dirname(localPath), {
  recursive: true,
});
await copyFile(localSource, localPath);
const regional = JSON.parse(
  await readFile(regionalPath, "utf8"),
);
const profiles = ["small", "medium", "large"];
const indexSets = ["none", "one", "two"];
const rows = profiles.flatMap((profile) =>
  indexSets.map((indexSet) => {
    const baseline =
      regional.overall.cases[
        `write-${profile}-${indexSet}-baseline`
      ];
    const context =
      regional.overall.cases[
        `write-${profile}-${indexSet}-tree-context`
      ];
    const comparison =
      regional.overall.comparisons[
        `${profile}-${indexSet}`
      ];
    return {
      profile,
      documents:
        regional.profiles[profile],
      indexSet,
      indexCount:
        regional.indexSets[indexSet].count,
      baselineP50Ms: baseline.clientP50Ms,
      contextP50Ms: context.clientP50Ms,
      p50ChangePercent:
        comparison.p50ChangePercent,
      baselineP95Ms: baseline.clientP95Ms,
      contextP95Ms: context.clientP95Ms,
      p95ChangePercent:
        comparison.p95ChangePercent,
      contextCombinedP50Ms:
        context.combinedP50Ms,
      baselineReads: baseline.meanReads,
      contextReads: context.meanReads,
      contextRequestBytes:
        context.meanRequestBytes,
    };
  }),
);
await writeFile(
  csvPath,
  [
    [
      "profile",
      "documents",
      "index_set",
      "index_count",
      "baseline_p50_ms",
      "context_p50_ms",
      "p50_change_percent",
      "baseline_p95_ms",
      "context_p95_ms",
      "p95_change_percent",
      "context_combined_p50_ms",
      "baseline_reads",
      "context_reads",
      "context_request_bytes",
    ].join(","),
    ...rows.map((row) =>
      [
        row.profile,
        row.documents,
        row.indexSet,
        row.indexCount,
        row.baselineP50Ms,
        row.contextP50Ms,
        row.p50ChangePercent,
        row.baselineP95Ms,
        row.contextP95Ms,
        row.p95ChangePercent,
        row.contextCombinedP50Ms,
        row.baselineReads,
        row.contextReads,
        row.contextRequestBytes,
      ].join(","),
    ),
    "",
  ].join("\n"),
);
await writeFile(graphPath, graph(rows));
console.log(JSON.stringify({
  localPath,
  csvPath,
  graphPath,
}, null, 2));

async function latestLocalResult() {
  const root = path.resolve("benchmark-results");
  const files = (await readdir(root))
    .filter((file) =>
      /^client-assisted-trie-writes-\d+\.json$/.test(
        file,
      ),
    )
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(
      "No local client-assisted write result was found",
    );
  }
  return path.join(root, latest);
}

function graph(rows) {
  const width = 1_200;
  const height = 620;
  const margin = {
    top: 80,
    right: 40,
    bottom: 110,
    left: 90,
  };
  const chartWidth =
    width - margin.left - margin.right;
  const chartHeight =
    height - margin.top - margin.bottom;
  const maximum =
    Math.ceil(
      Math.max(
        ...rows.flatMap((row) => [
          row.baselineP50Ms,
          row.contextP50Ms,
        ]),
      ) / 1_000,
    ) * 1_000;
  const groupWidth = chartWidth / rows.length;
  const barWidth = Math.min(28, groupWidth * 0.3);
  const y = (value) =>
    margin.top +
    chartHeight -
    (value / maximum) * chartHeight;
  const bars = rows.flatMap((row, index) => {
    const center =
      margin.left +
      groupWidth * index +
      groupWidth / 2;
    return [
      `<rect x="${round(center - barWidth - 2)}" y="${round(y(row.baselineP50Ms))}" width="${round(barWidth)}" height="${round(margin.top + chartHeight - y(row.baselineP50Ms))}" fill="#0b1f3a"/>`,
      `<rect x="${round(center + 2)}" y="${round(y(row.contextP50Ms))}" width="${round(barWidth)}" height="${round(margin.top + chartHeight - y(row.contextP50Ms))}" fill="#1677ff"/>`,
      `<text x="${round(center)}" y="${height - 74}" text-anchor="middle" font-size="13" fill="#0b1f3a">${label(row)}</text>`,
      `<text x="${round(center)}" y="${height - 54}" text-anchor="middle" font-size="12" fill="#526274">${row.p50ChangePercent}%</text>`,
    ];
  });
  const ticks = Array.from(
    { length: 8 },
    (_, index) => (maximum / 7) * index,
  ).map((value) => {
    const position = y(value);
    return [
      `<line x1="${margin.left}" y1="${round(position)}" x2="${width - margin.right}" y2="${round(position)}" stroke="#d8e1ee"/>`,
      `<text x="${margin.left - 12}" y="${round(position + 4)}" text-anchor="end" font-size="12" fill="#526274">${Math.round(value).toLocaleString("en-US")}</text>`,
    ].join("");
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    `<title id="title">Client-assisted Trie write p50 latency</title>`,
    `<desc id="description">Baseline and warm Trie-path context p50 latency across three collection sizes and zero, one, or two indexes.</desc>`,
    `<rect width="${width}" height="${height}" fill="#f5f8fd"/>`,
    `<text x="${margin.left}" y="36" font-size="25" font-weight="700" fill="#0b1f3a">Warm Trie-path context reduces regional write latency</text>`,
    `<text x="${margin.left}" y="61" font-size="14" fill="#526274">Pooled p50 across seven Azure regions and two pristine R2 replicates. Lower is better.</text>`,
    ...ticks,
    `<line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#0b1f3a"/>`,
    ...bars,
    `<rect x="${width - 320}" y="24" width="16" height="16" fill="#0b1f3a"/>`,
    `<text x="${width - 296}" y="37" font-size="13" fill="#0b1f3a">Baseline</text>`,
    `<rect x="${width - 210}" y="24" width="16" height="16" fill="#1677ff"/>`,
    `<text x="${width - 186}" y="37" font-size="13" fill="#0b1f3a">Warm context</text>`,
    `<text x="24" y="${margin.top + chartHeight / 2}" transform="rotate(-90 24 ${margin.top + chartHeight / 2})" text-anchor="middle" font-size="14" fill="#526274">p50 latency (ms)</text>`,
    `<text x="${width / 2}" y="${height - 16}" text-anchor="middle" font-size="12" fill="#526274">S/M/L = 128 / 5,000 / 25,000 documents; number = index count; percentages show warm-context change.</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function label(row) {
  const prefix = {
    small: "S",
    medium: "M",
    large: "L",
  }[row.profile];
  return `${prefix}${row.indexCount}`;
}

function round(value) {
  return Number(value.toFixed(2));
}
