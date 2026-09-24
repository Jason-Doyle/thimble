import type { CollectionLayout } from "./snapshot-protocol.js";

export type CollectionWorkloadEvidence = {
  documentCount: number;
  averageDocumentBytes: number;
  pointReadRatio: number;
  scanRatio: number;
  writesPerMinute: number;
  concurrentWriters: number;
};

export type LayoutRecommendation = {
  layout: CollectionLayout;
  confidence: "low" | "medium" | "high";
  estimatedCollectionBytes: number;
  reasons: string[];
};

export function recommendCollectionLayout(
  evidence: CollectionWorkloadEvidence,
): LayoutRecommendation {
  validateEvidence(evidence);
  const estimatedCollectionBytes =
    evidence.documentCount * evidence.averageDocumentBytes;
  const snapshotSignals = [
    estimatedCollectionBytes <= 256 * 1024,
    evidence.writesPerMinute <= 1,
    evidence.concurrentWriters <= 1,
    evidence.scanRatio >= 0.35,
  ];
  const trieSignals = [
    estimatedCollectionBytes >= 512 * 1024,
    evidence.writesPerMinute >= 5,
    evidence.concurrentWriters >= 2,
    evidence.pointReadRatio >= 0.7,
  ];
  const snapshotScore = snapshotSignals.filter(Boolean).length;
  const trieScore = trieSignals.filter(Boolean).length;
  const layout: CollectionLayout =
    snapshotScore > trieScore ? "snapshot" : "trie";
  const difference = Math.abs(snapshotScore - trieScore);
  const confidence =
    difference >= 3 ? "high" : difference >= 2 ? "medium" : "low";
  const reasons =
    layout === "snapshot"
      ? [
          estimatedCollectionBytes <= 256 * 1024
            ? "The estimated collection payload is at most 256 KiB."
            : "The collection is larger than the preferred snapshot payload.",
          evidence.writesPerMinute <= 1
            ? "The measured write rate is at most one write per minute."
            : "The write rate creates snapshot rewrite amplification.",
          evidence.scanRatio >= 0.35
            ? "Scans represent at least 35% of reads."
            : "Point reads dominate scans.",
        ]
      : [
          estimatedCollectionBytes >= 512 * 1024
            ? "The estimated collection payload is at least 512 KiB."
            : "The collection is below the strong trie size threshold.",
          evidence.concurrentWriters >= 2
            ? "The workload includes concurrent writers."
            : "The workload has at most one writer.",
          evidence.pointReadRatio >= 0.7
            ? "Point reads represent at least 70% of reads."
            : "Point reads do not dominate the workload.",
        ];
  return {
    layout,
    confidence,
    estimatedCollectionBytes,
    reasons,
  };
}

function validateEvidence(
  evidence: CollectionWorkloadEvidence,
): void {
  for (const [name, value] of Object.entries(evidence)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number`);
    }
  }
  if (
    evidence.pointReadRatio > 1 ||
    evidence.scanRatio > 1 ||
    evidence.pointReadRatio + evidence.scanRatio > 1.000_001
  ) {
    throw new Error("Read ratios must be between zero and one");
  }
}
