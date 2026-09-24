import { recommendCollectionLayout } from "./layout-advisor.js";

const evidence = {
  documentCount: number("THIMBLE_DOCUMENT_COUNT"),
  averageDocumentBytes: number("THIMBLE_AVERAGE_DOCUMENT_BYTES"),
  pointReadRatio: number("THIMBLE_POINT_READ_RATIO"),
  scanRatio: number("THIMBLE_SCAN_RATIO"),
  writesPerMinute: number("THIMBLE_WRITES_PER_MINUTE"),
  concurrentWriters: number("THIMBLE_CONCURRENT_WRITERS"),
};

console.log(
  JSON.stringify(recommendCollectionLayout(evidence), null, 2),
);

function number(name: string): number {
  const value = process.env[name];
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} is required and must be numeric`);
  }
  return parsed;
}
