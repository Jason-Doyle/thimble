import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_REGIONS,
} from "./scenario.ts";

const evidencePath = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_EVIDENCE ??
    "evidence/r2-current-layout-multiregion-2026-09-25.json",
);
const evidence = JSON.parse(
  await readFile(evidencePath, "utf8"),
);
const csvPath = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_CSV ??
    "evidence/r2-current-layout-summary-2026-09-25.csv",
);
const chartRoot = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_CHARTS ??
    "site/public/benchmarks",
);
const summaryPath = path.resolve(
  process.env.THIMBLE_CURRENT_REGIONAL_SITE_SUMMARY ??
    "site/src/data/current-benchmark.json",
);

await Promise.all([
  mkdir(path.dirname(csvPath), { recursive: true }),
  mkdir(chartRoot, { recursive: true }),
  mkdir(path.dirname(summaryPath), { recursive: true }),
]);

await writeFile(csvPath, createCsv(evidence));
await writeFile(
  path.join(chartRoot, "point-p95-by-scale.svg"),
  groupedBarChart({
    title: "Cold point-read p95 by collection size",
    description:
      "Regional caller latency pooled across seven Azure regions and two replicates. Lower is better.",
    categories: ["Small", "Medium", "Large"],
    series: [
      {
        label: "Snapshot",
        color: "#2563eb",
        values: profileValues(
          evidence,
          "point",
          "point-snapshot",
        ),
      },
      {
        label: "Trie",
        color: "#0891b2",
        values: profileValues(
          evidence,
          "point",
          "point-trie",
        ),
      },
      {
        label: "Trie bundle",
        color: "#7c3aed",
        values: profileValues(
          evidence,
          "point",
          "bundle-trie",
        ),
      },
    ],
    valueLabel: "milliseconds",
  }),
);
await writeFile(
  path.join(chartRoot, "large-read-p95.svg"),
  groupedBarChart({
    title: "Large-profile read p95 by operation",
    description:
      "Twenty-five-thousand-document profile. Lower is better. Failed operations are reported separately in the benchmark tables.",
    categories: [
      "Point",
      "Covered equality",
      "Uncovered equality",
      "Full scan",
    ],
    series: [
      {
        label: "Snapshot",
        color: "#2563eb",
        values: [
          readMetric(evidence, "large", "point", "point-snapshot"),
          readMetric(
            evidence,
            "large",
            "queries",
            "covered-equality-snapshot",
          ),
          readMetric(
            evidence,
            "large",
            "queries",
            "uncovered-equality-snapshot",
          ),
          readMetric(evidence, "large", "scans", "scan-snapshot"),
        ],
      },
      {
        label: "Trie",
        color: "#0891b2",
        values: [
          readMetric(evidence, "large", "point", "point-trie"),
          readMetric(
            evidence,
            "large",
            "queries",
            "covered-equality-trie",
          ),
          readMetric(
            evidence,
            "large",
            "queries",
            "uncovered-equality-trie",
          ),
          readMetric(evidence, "large", "scans", "scan-trie"),
        ],
      },
    ],
    valueLabel: "milliseconds",
  }),
);
await writeFile(
  path.join(chartRoot, "regional-large-point-p95.svg"),
  groupedBarChart({
    title: "Large-profile cold point-read p95 by region",
    description:
      "Twenty-five-thousand-document profile across two replicates. Lower is better.",
    categories: BENCHMARK_REGIONS.map(regionLabel),
    series: [
      {
        label: "Snapshot",
        color: "#2563eb",
        values: regionValues(
          evidence,
          "point-snapshot",
        ),
      },
      {
        label: "Trie",
        color: "#0891b2",
        values: regionValues(evidence, "point-trie"),
      },
      {
        label: "Trie bundle",
        color: "#7c3aed",
        values: regionValues(evidence, "bundle-trie"),
      },
    ],
    valueLabel: "milliseconds",
  }),
);
await writeFile(
  path.join(chartRoot, "write-p95.svg"),
  groupedBarChart({
    title: "Large-profile write p95",
    description:
      "Single-writer and simultaneous multi-region writes. Lower is better.",
    categories: ["Single writer", "Multi-region contention"],
    series: [
      {
        label: "Snapshot",
        color: "#2563eb",
        values: [
          evidence.overall.writes.cases["write-snapshot"]
            .clientP95Ms,
          evidence.overall.contention.cases[
            "contention-snapshot"
          ].clientP95Ms,
        ],
      },
      {
        label: "Trie",
        color: "#0891b2",
        values: [
          evidence.overall.writes.cases["write-trie"]
            .clientP95Ms,
          evidence.overall.contention.cases[
            "contention-trie"
          ].clientP95Ms,
        ],
      },
    ],
    valueLabel: "milliseconds",
  }),
);

const large = evidence.overall.reads.large;
const summary = {
  generatedAt: evidence.generatedAt,
  sourceCommit: evidence.sourceCommit,
  evidence:
    "/evidence/r2-current-layout-multiregion-2026-09-25.json",
  regions: BENCHMARK_REGIONS.length,
  measuredOperations: evidence.totals.measuredOperations,
  profiles: Object.fromEntries(
    Object.entries(evidence.profiles).map(
      ([name, profile]) => [
        name,
        profile.documents,
      ],
    ),
  ),
  largePointP95Ms: {
    snapshot: large.point["point-snapshot"].clientP95Ms,
    trie: large.point["point-trie"].clientP95Ms,
    trieBundle: large.point["bundle-trie"].clientP95Ms,
  },
  largeScanP95Ms: {
    snapshot: large.scans["scan-snapshot"].clientP95Ms,
    trie: large.scans["scan-trie"].clientP95Ms,
  },
  singleWriteP95Ms: {
    snapshot:
      evidence.overall.writes.cases["write-snapshot"]
        .clientP95Ms,
    trie:
      evidence.overall.writes.cases["write-trie"]
        .clientP95Ms,
  },
  contentionSuccessRatePercent: {
    snapshot:
      evidence.overall.contention.cases[
        "contention-snapshot"
      ].successRatePercent,
    trie:
      evidence.overall.contention.cases[
        "contention-trie"
      ].successRatePercent,
  },
};
await writeFile(
  summaryPath,
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({
  csvPath,
  chartRoot,
  summaryPath,
}, null, 2));

function createCsv(value) {
  const rows = [[
    "group",
    "profile",
    "case",
    "operations",
    "successful",
    "failed",
    "client_p50_ms",
    "client_p95_ms",
    "mean_network_reads",
    "mean_network_bytes",
    "mean_object_reads",
    "mean_object_bytes",
    "mean_cas_retries",
  ]];
  for (const [profile, groups] of Object.entries(
    value.overall.reads,
  )) {
    for (const group of ["point", "queries", "scans"]) {
      for (const [caseName, summary] of Object.entries(
        groups[group],
      )) {
        rows.push([
          group,
          profile,
          caseName,
          summary.operations,
          summary.successful,
          summary.failed,
          summary.clientP50Ms,
          summary.clientP95Ms,
          summary.meanNetworkReads,
          summary.meanNetworkBytes,
          summary.meanObjectReads,
          summary.meanObjectBytes,
          "",
        ]);
      }
    }
  }
  for (const group of ["writes", "contention"]) {
    for (const [caseName, summary] of Object.entries(
      value.overall[group].cases,
    )) {
      rows.push([
        group,
        "large",
        caseName,
        summary.operations,
        summary.successful,
        summary.failed,
        summary.clientP50Ms,
        summary.clientP95Ms,
        "",
        "",
        summary.meanObjectReads,
        summary.meanObjectBytesWritten,
        summary.meanCasRetries,
      ]);
    }
  }
  return `${rows.map((row) =>
    row.map(csvValue).join(","),
  ).join("\n")}\n`;
}

function profileValues(value, group, caseName) {
  return ["small", "medium", "large"].map(
    (profile) =>
      value.overall.reads[profile][group][caseName]
        .clientP95Ms,
  );
}

function regionValues(value, caseName) {
  return BENCHMARK_REGIONS.map(
    (region) =>
      value.regions[region].reads.large.point[caseName]
        .clientP95Ms,
  );
}

function readMetric(value, profile, group, caseName) {
  return value.overall.reads[profile][group][caseName]
    .clientP95Ms;
}

function groupedBarChart({
  title,
  description,
  categories,
  series,
  valueLabel,
}) {
  const width = 1_080;
  const left = 190;
  const right = 120;
  const top = 100;
  const barHeight = 18;
  const barGap = 8;
  const groupGap = 28;
  const groupHeight =
    series.length * (barHeight + barGap) + groupGap;
  const height =
    top + categories.length * groupHeight + 90;
  const chartWidth = width - left - right;
  const maximum = Math.max(
    1,
    ...series.flatMap((entry) => entry.values),
  );
  const roundedMaximum = niceMaximum(maximum);
  const ticks = 5;
  const elements = [];

  for (let index = 0; index <= ticks; index += 1) {
    const value = (roundedMaximum / ticks) * index;
    const x = left + (chartWidth / ticks) * index;
    elements.push(
      `<line x1="${x}" y1="${top - 20}" x2="${x}" y2="${height - 55}" stroke="#dbe4ef" stroke-width="1"/>`,
      `<text x="${x}" y="${height - 28}" text-anchor="middle" class="axis">${formatNumber(value)}</text>`,
    );
  }

  categories.forEach((category, categoryIndex) => {
    const groupTop = top + categoryIndex * groupHeight;
    elements.push(
      `<text x="${left - 16}" y="${groupTop + 16}" text-anchor="end" class="category">${escapeXml(category)}</text>`,
    );
    series.forEach((entry, seriesIndex) => {
      const value = entry.values[categoryIndex] ?? 0;
      const y =
        groupTop +
        seriesIndex * (barHeight + barGap);
      const barWidth =
        (value / roundedMaximum) * chartWidth;
      elements.push(
        `<rect x="${left}" y="${y}" width="${Math.max(1, barWidth)}" height="${barHeight}" rx="4" fill="${entry.color}"/>`,
        `<text x="${Math.min(width - 8, left + barWidth + 8)}" y="${y + 14}" class="value">${formatNumber(value)} ms</text>`,
      );
    });
  });

  const legend = series.map((entry, index) => {
    const x = left + index * 190;
    return [
      `<rect x="${x}" y="52" width="16" height="16" rx="3" fill="${entry.color}"/>`,
      `<text x="${x + 24}" y="65" class="legend">${escapeXml(entry.label)}</text>`,
    ].join("");
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>
    text { font-family: Inter, Arial, sans-serif; fill: #1e293b; }
    .title { font-size: 24px; font-weight: 700; }
    .description { font-size: 13px; fill: #475569; }
    .legend, .category, .value, .axis { font-size: 12px; }
    .category { font-weight: 600; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="24" y="30" class="title">${escapeXml(title)}</text>
  <text x="24" y="48" class="description">${escapeXml(description)}</text>
  ${legend}
  ${elements.join("\n  ")}
  <text x="${left + chartWidth / 2}" y="${height - 6}" text-anchor="middle" class="axis">${escapeXml(valueLabel)}</text>
</svg>
`;
}

function niceMaximum(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice =
    normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 5
          ? 5
          : 10;
  return nice * magnitude;
}

function formatNumber(value) {
  if (value >= 1_000) {
    return Math.round(value).toLocaleString("en-US");
  }
  return Number(value.toFixed(1)).toString();
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function regionLabel(region) {
  return {
    eastus: "East US",
    westus2: "West US 2",
    northeurope: "North Europe",
    southeastasia: "Southeast Asia",
    japaneast: "Japan East",
    australiaeast: "Australia East",
    brazilsouth: "Brazil South",
  }[region] ?? region;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
