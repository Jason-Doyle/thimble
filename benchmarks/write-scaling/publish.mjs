import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const currentEvidencePath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_CURRENT_EVIDENCE ??
    "evidence/write-scaling-regional-worker-2026-09-28.json",
);
const baselineEvidencePath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_BASELINE_EVIDENCE ??
    "evidence/write-scaling-regional-worker-2026-09-27.json",
);
const currentLocalPath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_CURRENT_LOCAL ??
    "evidence/write-scaling-local-2026-09-28.json",
);
const baselineLocalPath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_BASELINE_LOCAL ??
    "evidence/write-scaling-local-2026-09-27.json",
);
const baselineLocalRerunPath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_BASELINE_LOCAL_RERUN ??
    "evidence/write-scaling-local-baseline-rerun-2026-09-28.json",
);
const csvPath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_COMPARISON_CSV ??
    "evidence/write-scaling-comparison-2026-09-28.csv",
);
const chartPath = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_CHART ??
    "site/public/benchmarks/write-scaling-p50.svg",
);
const publicEvidenceRoot = path.resolve(
  process.env.THIMBLE_WRITE_SCALING_PUBLIC_EVIDENCE ??
    "site/public/evidence",
);

const current = JSON.parse(
  await readFile(currentEvidencePath, "utf8"),
);
const baseline = JSON.parse(
  await readFile(baselineEvidencePath, "utf8"),
);

await Promise.all([
  mkdir(path.dirname(csvPath), { recursive: true }),
  mkdir(path.dirname(chartPath), { recursive: true }),
  mkdir(publicEvidenceRoot, { recursive: true }),
]);

await writeFile(
  csvPath,
  comparisonCsv(current, baseline),
);
await writeFile(
  chartPath,
  currentP50Chart(current),
);
await Promise.all(
  [
    currentEvidencePath,
    baselineEvidencePath,
    currentLocalPath,
    baselineLocalPath,
    baselineLocalRerunPath,
    csvPath,
  ].map((source) =>
    copyFile(
      source,
      path.join(
        publicEvidenceRoot,
        path.basename(source),
      ),
    ),
  ),
);

console.log(JSON.stringify({
  csvPath,
  chartPath,
  publicEvidenceRoot,
}, null, 2));

function comparisonCsv(currentValue, baselineValue) {
  const rows = [[
    "case",
    "profile",
    "documents",
    "indexes",
    "layout",
    "baseline_successful",
    "baseline_failed",
    "baseline_p50_ms",
    "baseline_p95_ms",
    "current_successful",
    "current_failed",
    "current_p50_ms",
    "current_p95_ms",
    "p50_change_percent",
    "p95_change_percent",
    "current_mean_reads",
    "current_mean_read_bytes",
    "current_mean_writes",
    "current_mean_write_bytes",
  ]];
  for (const name of Object.keys(
    currentValue.overall.cases,
  )) {
    const currentCase =
      currentValue.overall.cases[name];
    const baselineCase =
      baselineValue.overall.cases[name];
    const parsed = parseCase(name);
    rows.push([
      name,
      parsed.profile,
      currentValue.profiles[parsed.profile],
      parsed.indexes,
      parsed.layout,
      baselineCase.successful,
      baselineCase.failed,
      baselineCase.clientP50Ms,
      baselineCase.clientP95Ms,
      currentCase.successful,
      currentCase.failed,
      currentCase.clientP50Ms,
      currentCase.clientP95Ms,
      change(
        currentCase.clientP50Ms,
        baselineCase.clientP50Ms,
      ),
      change(
        currentCase.clientP95Ms,
        baselineCase.clientP95Ms,
      ),
      currentCase.meanReads,
      currentCase.meanReadBytes,
      currentCase.meanWrites,
      currentCase.meanWriteBytes,
    ]);
  }
  return `${rows
    .map((row) =>
      row.map(csvValue).join(","),
    )
    .join("\n")}\n`;
}

function currentP50Chart(value) {
  const profiles = [
    ["small", "128 documents"],
    ["medium", "5,000 documents"],
    ["large", "25,000 documents"],
  ];
  const series = [
    ["Snapshot, 0 indexes", "#93c5fd", "none", "snapshot"],
    ["Snapshot, 1 index", "#3b82f6", "one", "snapshot"],
    ["Snapshot, 2 indexes", "#1d4ed8", "two", "snapshot"],
    ["Trie, 0 indexes", "#67e8f9", "none", "trie"],
    ["Trie, 1 index", "#06b6d4", "one", "trie"],
    ["Trie, 2 indexes", "#0e7490", "two", "trie"],
  ].map(([label, color, indexes, layout]) => ({
    label,
    color,
    values: profiles.map(
      ([profile]) =>
        value.overall.cases[
          `write-${profile}-${indexes}-${layout}`
        ].clientP50Ms,
    ),
  }));
  return groupedBarChart({
    title: "Post-merge one-document write p50",
    description:
      "Seven Azure regions and two replicates. Lower is better. Failed operations are reported separately.",
    categories: profiles.map(([, label]) => label),
    series,
    valueLabel: "milliseconds",
  });
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
  const top = 125;
  const barHeight = 18;
  const barGap = 8;
  const groupGap = 30;
  const groupHeight =
    series.length * (barHeight + barGap) +
    groupGap;
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
    const groupTop =
      top + categoryIndex * groupHeight;
    elements.push(
      `<text x="${left - 16}" y="${groupTop + 16}" text-anchor="end" class="category">${escapeXml(category)}</text>`,
    );
    series.forEach((entry, seriesIndex) => {
      const value =
        entry.values[categoryIndex] ?? 0;
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

  const legend = series
    .map((entry, index) => {
      const x = left + index * 140;
      return [
        `<rect x="${x}" y="76" width="16" height="16" rx="3" fill="${entry.color}"/>`,
        `<text x="${x + 22}" y="89" class="legend">${escapeXml(entry.label)}</text>`,
      ].join("");
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>
    text { font-family: Inter, Arial, sans-serif; fill: #1e293b; }
    .title { font-size: 24px; font-weight: 700; }
    .description { font-size: 13px; fill: #475569; }
    .legend, .category, .value, .axis { font-size: 11px; }
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

function parseCase(name) {
  const match =
    /^write-(small|medium|large)-(none|one|two)-(snapshot|trie)$/.exec(
      name,
    );
  if (!match) {
    throw new Error(
      `Unexpected write-scaling case ${name}`,
    );
  }
  return {
    profile: match[1],
    indexes: match[2],
    layout: match[3],
  };
}

function change(value, baseline) {
  return Number(
    (((value - baseline) / baseline) * 100)
      .toFixed(2),
  );
}

function niceMaximum(value) {
  const magnitude =
    10 ** Math.floor(Math.log10(value));
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
    return Math.round(value).toLocaleString(
      "en-US",
    );
  }
  return Number(value.toFixed(1)).toString();
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
