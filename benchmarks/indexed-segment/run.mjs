import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildIndexedSegment,
  HttpIndexedSegmentSource,
  IndexedSegmentReader,
  MemoryIndexedSegmentSource,
} from "../../src/experimental/indexed-segment.ts";
import {
  FileIndexedSegmentSource,
} from "../../src/experimental/indexed-segment-node.ts";
import {
  decodeEnvelope,
  encodeEnvelope,
  importAesGcmKey,
} from "../../src/envelope.ts";
import {
  decodeJson,
  encodeJson,
} from "../../src/shared-utils.ts";

const sizes = configuredSizes();
const benchmarkKeys = await createBenchmarkKeys();
const results = [];

for (const size of sizes) {
  results.push(await benchmarkSize(size));
}

const output = {
  generatedAt: new Date().toISOString(),
  warning:
    "Experimental local evidence only. HTTP Range requests are simulated against in-memory bytes; results do not include network latency, a live object store, or production write coordination.",
  format:
    "TIS1 prototype: TDB1-wrapped independent blocks, footer, and sharded 64-bit ID fingerprint indexes; JSON or binary records; Bloom filters; and range zone maps.",
  results,
};

await mkdir("benchmark-results", { recursive: true });
const outputPath = path.resolve(
  "benchmark-results",
  `indexed-segment-${Date.now()}.json`,
);
await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
console.log(`Raw result: ${outputPath}`);

async function benchmarkSize(size) {
  const documents = notes(size);
  const fields = [
    { field: "category", mode: "equality" },
    { field: "bucket", mode: "equality" },
    { field: "lastModified", mode: "range" },
  ];
  const snapshotValue = {
    documents: Object.fromEntries(
      documents.map((document) => [document.id, document]),
    ),
  };

  const segmentBuild = await measure(async () =>
    buildIndexedSegment(documents, {
      targetBlockBytes: 64 * 1024,
      fields,
    }),
  );
  const segment = segmentBuild.value;
  const binarySegmentBuild = await measure(async () =>
    buildIndexedSegment(documents, {
      targetBlockBytes: 64 * 1024,
      recordEncoding: "binary",
      fields,
    }),
  );
  const binarySegment = binarySegmentBuild.value;
  const encryptedSegmentBuild = await measure(async () =>
    buildIndexedSegment(documents, {
      targetBlockBytes: 64 * 1024,
      fields,
      security: {
        key: benchmarkKeys.encryptionKey,
        keyId: "benchmark-key",
        fingerprintKey: benchmarkKeys.fingerprintKey,
        context: `benchmark/${size}`,
      },
    }),
  );
  const encryptedSegment = encryptedSegmentBuild.value;
  const snapshotJsonBuild = await measure(async () =>
    encodeJson(snapshotValue),
  );
  const snapshotJson = snapshotJsonBuild.value;
  const snapshotEnvelopeBuild = await measure(async () =>
    encodeEnvelope(snapshotJson, { compression: "gzip" }),
  );
  const snapshotEnvelope = snapshotEnvelopeBuild.value;
  const directoryReader = await IndexedSegmentReader.open(
    new MemoryIndexedSegmentSource(segment),
    { cacheBlocks: false },
  );
  const diagnostics = directoryReader.diagnostics();
  const binaryDirectoryReader =
    await IndexedSegmentReader.open(
      new MemoryIndexedSegmentSource(binarySegment),
      { cacheBlocks: false },
    );
  const binaryDiagnostics =
    binaryDirectoryReader.diagnostics();
  const pointIds = sampledIds(documents);

  const cachedDirectorySource =
    new MemoryIndexedSegmentSource(segment);
  const cachedDirectoryReader =
    await IndexedSegmentReader.open(
      cachedDirectorySource,
      { cacheBlocks: false },
    );
  cachedDirectorySource.resetMetrics();
  const cachedDirectoryPoint = await measure(async () => {
    for (const id of pointIds) {
      const document = await cachedDirectoryReader.get(id);
      if (!document || document.id !== id) {
        throw new Error(`Indexed segment missed ${id}`);
      }
    }
  });

  const coldPoint = await measure(async () => {
    let reads = 0;
    let bytes = 0;
    for (const id of pointIds) {
      const source = new MemoryIndexedSegmentSource(segment);
      const reader = await IndexedSegmentReader.open(source, {
        cacheBlocks: false,
      });
      const document = await reader.get(id);
      if (!document || document.id !== id) {
        throw new Error(`Indexed segment missed ${id}`);
      }
      reads += source.reads;
      bytes += source.bytesRead;
    }
    return { reads, bytes };
  });
  const filePoint = await benchmarkFilePoints(
    segment,
    pointIds,
  );
  const httpPoints = await benchmarkHttpPoints(
    segment,
    pointIds,
  );

  const snapshotPoint = await measure(async () => {
    for (const id of pointIds) {
      const decoded = decodeJson(
        await decodeEnvelope(snapshotEnvelope),
      );
      const document = decoded.documents[id];
      if (!document || document.id !== id) {
        throw new Error(`Snapshot missed ${id}`);
      }
    }
  });

  const binaryPointSource =
    new MemoryIndexedSegmentSource(binarySegment);
  const binaryPointReader = await IndexedSegmentReader.open(
    binaryPointSource,
    { cacheBlocks: false },
  );
  binaryPointSource.resetMetrics();
  const binaryPoint = await measure(async () => {
    for (const id of pointIds) {
      const document = await binaryPointReader.get(id);
      if (!document || document.id !== id) {
        throw new Error(`Binary indexed segment missed ${id}`);
      }
    }
  });

  const encryptedPointSource =
    new MemoryIndexedSegmentSource(encryptedSegment);
  const encryptedPointReader =
    await IndexedSegmentReader.open(
      encryptedPointSource,
      {
        cacheBlocks: false,
        security: {
          resolveKey: (keyId) =>
            keyId === "benchmark-key"
              ? benchmarkKeys.encryptionKey
              : null,
          fingerprintKey: benchmarkKeys.fingerprintKey,
          context: `benchmark/${size}`,
        },
      },
    );
  encryptedPointSource.resetMetrics();
  const encryptedPoint = await measure(async () => {
    for (const id of pointIds) {
      const document = await encryptedPointReader.get(id);
      if (!document || document.id !== id) {
        throw new Error(`Encrypted indexed segment missed ${id}`);
      }
    }
  });

  const rareExpected = documents.filter(
    (document) => document.category === "rare",
  );
  const equalitySource = new MemoryIndexedSegmentSource(segment);
  const equalityReader = await IndexedSegmentReader.open(
    equalitySource,
    { cacheBlocks: false },
  );
  equalitySource.resetMetrics();
  const equality = await measure(() =>
    equalityReader.query({
      field: "category",
      operator: "eq",
      value: "rare",
    }),
  );
  assertCount(
    equality.value.documents.length,
    rareExpected.length,
    "segment equality",
  );

  const rangeLower = Math.floor(size * 0.7);
  const rangeUpper = Math.min(size - 1, rangeLower + 24);
  const rangeExpected = documents.filter(
    (document) =>
      document.lastModified >= rangeLower &&
      document.lastModified <= rangeUpper,
  );
  const rangeSource = new MemoryIndexedSegmentSource(segment);
  const rangeReader = await IndexedSegmentReader.open(
    rangeSource,
    { cacheBlocks: false },
  );
  rangeSource.resetMetrics();
  const range = await measure(() =>
    rangeReader.query({
      field: "lastModified",
      operator: "between",
      lower: rangeLower,
      upper: rangeUpper,
    }),
  );
  assertCount(
    range.value.documents.length,
    rangeExpected.length,
    "segment range",
  );

  const distributedExpected = documents.filter(
    (document) => document.bucket === "bucket-07",
  );
  const distributedSource =
    new MemoryIndexedSegmentSource(segment);
  const distributedReader = await IndexedSegmentReader.open(
    distributedSource,
    { cacheBlocks: false },
  );
  distributedSource.resetMetrics();
  const distributed = await measure(() =>
    distributedReader.query({
      field: "bucket",
      operator: "eq",
      value: "bucket-07",
    }),
  );
  assertCount(
    distributed.value.documents.length,
    distributedExpected.length,
    "segment distributed equality",
  );

  const snapshotEquality = await measure(async () => {
    const decoded = decodeJson(
      await decodeEnvelope(snapshotEnvelope),
    );
    return Object.values(decoded.documents).filter(
      (document) => document.category === "rare",
    );
  });
  assertCount(
    snapshotEquality.value.length,
    rareExpected.length,
    "snapshot equality",
  );

  const segmentScanSource =
    new MemoryIndexedSegmentSource(segment);
  const segmentScanReader = await IndexedSegmentReader.open(
    segmentScanSource,
    { cacheBlocks: false },
  );
  segmentScanSource.resetMetrics();
  const segmentScan = await measure(() =>
    segmentScanReader.scan(),
  );
  assertCount(
    segmentScan.value.length,
    documents.length,
    "segment scan",
  );

  const snapshotScan = await measure(async () => {
    const decoded = decodeJson(
      await decodeEnvelope(snapshotEnvelope),
    );
    return Object.values(decoded.documents);
  });
  assertCount(
    snapshotScan.value.length,
    documents.length,
    "snapshot scan",
  );

  const binaryEqualitySource =
    new MemoryIndexedSegmentSource(binarySegment);
  const binaryEqualityReader =
    await IndexedSegmentReader.open(
      binaryEqualitySource,
      { cacheBlocks: false },
    );
  binaryEqualitySource.resetMetrics();
  const binaryEquality = await measure(() =>
    binaryEqualityReader.query({
      field: "category",
      operator: "eq",
      value: "rare",
    }),
  );
  assertCount(
    binaryEquality.value.documents.length,
    rareExpected.length,
    "binary segment equality",
  );

  const binaryRangeSource =
    new MemoryIndexedSegmentSource(binarySegment);
  const binaryRangeReader = await IndexedSegmentReader.open(
    binaryRangeSource,
    { cacheBlocks: false },
  );
  binaryRangeSource.resetMetrics();
  const binaryRange = await measure(() =>
    binaryRangeReader.query({
      field: "lastModified",
      operator: "between",
      lower: rangeLower,
      upper: rangeUpper,
    }),
  );
  assertCount(
    binaryRange.value.documents.length,
    rangeExpected.length,
    "binary segment range",
  );

  const binaryScanSource =
    new MemoryIndexedSegmentSource(binarySegment);
  const binaryScanReader = await IndexedSegmentReader.open(
    binaryScanSource,
    { cacheBlocks: false },
  );
  binaryScanSource.resetMetrics();
  const binaryScan = await measure(() =>
    binaryScanReader.scan(),
  );
  assertCount(
    binaryScan.value.length,
    documents.length,
    "binary segment scan",
  );

  const replacement = {
    ...documents[Math.floor(size / 2)],
    body: "Updated deterministic body",
    lastModified: size + 1,
  };
  const updated = documents.map((document) =>
    document.id === replacement.id ? replacement : document,
  );
  const segmentRewrite = await measure(() =>
    buildIndexedSegment(updated, {
      targetBlockBytes: 64 * 1024,
      fields,
    }),
  );
  const snapshotRewrite = await measure(async () =>
    encodeEnvelope(
      encodeJson({
        documents: Object.fromEntries(
          updated.map((document) => [document.id, document]),
        ),
      }),
      { compression: "gzip" },
    ),
  );
  const binarySegmentRewrite = await measure(() =>
    buildIndexedSegment(updated, {
      targetBlockBytes: 64 * 1024,
      recordEncoding: "binary",
      fields,
    }),
  );

  return {
    documents: size,
    documentBytes: snapshotJson.byteLength,
    format: {
      segmentBytes: segment.byteLength,
      binarySegmentBytes: binarySegment.byteLength,
      encryptedSegmentBytes: encryptedSegment.byteLength,
      compressedSnapshotBytes: snapshotEnvelope.byteLength,
      segmentToSnapshotRatio: ratio(
        segment.byteLength,
        snapshotEnvelope.byteLength,
      ),
      binarySegmentToSnapshotRatio: ratio(
        binarySegment.byteLength,
        snapshotEnvelope.byteLength,
      ),
      binaryToJsonSegmentRatio: ratio(
        binarySegment.byteLength,
        segment.byteLength,
      ),
      encryptionSizeRatio: ratio(
        encryptedSegment.byteLength,
        segment.byteLength,
      ),
      blocks: diagnostics.blocks,
      footerBytes: diagnostics.footerBytes,
      footerPercent: percent(
        diagnostics.footerBytes,
        segment.byteLength,
      ),
      idIndexBytes: diagnostics.indexBytes,
      idIndexPercent: percent(
        diagnostics.indexBytes,
        segment.byteLength,
      ),
      dataCompressionRatio: ratio(
        diagnostics.dataBytes,
        diagnostics.decodedDataBytes,
      ),
      binaryBlocks: binaryDiagnostics.blocks,
      binaryFooterBytes: binaryDiagnostics.footerBytes,
      binaryFooterPercent: percent(
        binaryDiagnostics.footerBytes,
        binarySegment.byteLength,
      ),
      binaryIdIndexBytes: binaryDiagnostics.indexBytes,
      binaryIdIndexPercent: percent(
        binaryDiagnostics.indexBytes,
        binarySegment.byteLength,
      ),
      binaryDataCompressionRatio: ratio(
        binaryDiagnostics.dataBytes,
        binaryDiagnostics.decodedDataBytes,
      ),
    },
    build: {
      segmentMs: segmentBuild.durationMs,
      binarySegmentMs: binarySegmentBuild.durationMs,
      encryptedSegmentMs:
        encryptedSegmentBuild.durationMs,
      snapshotJsonMs: snapshotJsonBuild.durationMs,
      snapshotEnvelopeMs: snapshotEnvelopeBuild.durationMs,
    },
    pointReadWithCachedFooter: {
      samples: pointIds.length,
      durationMs: cachedDirectoryPoint.durationMs,
      durationPerReadMs: perOperation(
        cachedDirectoryPoint.durationMs,
        pointIds.length,
      ),
      rangeRequests: cachedDirectorySource.reads,
      bytesRead: cachedDirectorySource.bytesRead,
      bytesPerRead: Math.round(
        cachedDirectorySource.bytesRead / pointIds.length,
      ),
    },
    coldPointRead: {
      samples: pointIds.length,
      durationMs: coldPoint.durationMs,
      durationPerReadMs: perOperation(
        coldPoint.durationMs,
        pointIds.length,
      ),
      rangeRequests: coldPoint.value.reads,
      requestsPerRead: ratio(
        coldPoint.value.reads,
        pointIds.length,
      ),
      bytesRead: coldPoint.value.bytes,
      bytesPerRead: Math.round(
        coldPoint.value.bytes / pointIds.length,
      ),
    },
    fileRangePointReadWithCachedFooter: filePoint,
    simulatedHttpConnectedPointReads: httpPoints.connected,
    simulatedHttpColdPointRead: httpPoints.cold,
    compressedSnapshotPointRead: {
      samples: pointIds.length,
      durationMs: snapshotPoint.durationMs,
      durationPerReadMs: perOperation(
        snapshotPoint.durationMs,
        pointIds.length,
      ),
      bytesPerRead: snapshotEnvelope.byteLength,
    },
    binaryRecordEncoding: {
      pointReadWithCachedFooter: {
        samples: pointIds.length,
        durationMs: binaryPoint.durationMs,
        durationPerReadMs: perOperation(
          binaryPoint.durationMs,
          pointIds.length,
        ),
        rangeRequests: binaryPointSource.reads,
        bytesRead: binaryPointSource.bytesRead,
        bytesPerRead: Math.round(
          binaryPointSource.bytesRead / pointIds.length,
        ),
      },
      equalityQuery: {
        durationMs: binaryEquality.durationMs,
        bytesRead: binaryEqualitySource.bytesRead,
        blocksRead: binaryEquality.value.blocksRead,
        blocksSkipped: binaryEquality.value.blocksSkipped,
      },
      rangeQuery: {
        durationMs: binaryRange.durationMs,
        bytesRead: binaryRangeSource.bytesRead,
        blocksRead: binaryRange.value.blocksRead,
        blocksSkipped: binaryRange.value.blocksSkipped,
      },
      fullScan: {
        durationMs: binaryScan.durationMs,
        bytesRead: binaryScanSource.bytesRead,
      },
    },
    encryptedPointReadWithCachedFooter: {
      samples: pointIds.length,
      durationMs: encryptedPoint.durationMs,
      durationPerReadMs: perOperation(
        encryptedPoint.durationMs,
        pointIds.length,
      ),
      rangeRequests: encryptedPointSource.reads,
      bytesRead: encryptedPointSource.bytesRead,
      bytesPerRead: Math.round(
        encryptedPointSource.bytesRead / pointIds.length,
      ),
    },
    equalityQuery: {
      matches: equality.value.documents.length,
      segmentMs: equality.durationMs,
      segmentBytesRead: equalitySource.bytesRead,
      blocksRead: equality.value.blocksRead,
      blocksSkipped: equality.value.blocksSkipped,
      snapshotMs: snapshotEquality.durationMs,
      snapshotBytesRead: snapshotEnvelope.byteLength,
    },
    rangeQuery: {
      matches: range.value.documents.length,
      segmentMs: range.durationMs,
      segmentBytesRead: rangeSource.bytesRead,
      blocksRead: range.value.blocksRead,
      blocksSkipped: range.value.blocksSkipped,
    },
    distributedEqualityQuery: {
      matches: distributed.value.documents.length,
      segmentMs: distributed.durationMs,
      segmentBytesRead: distributedSource.bytesRead,
      blocksRead: distributed.value.blocksRead,
      blocksSkipped: distributed.value.blocksSkipped,
    },
    fullScan: {
      segmentMs: segmentScan.durationMs,
      segmentBytesRead: segmentScanSource.bytesRead,
      snapshotMs: snapshotScan.durationMs,
      snapshotBytesRead: snapshotEnvelope.byteLength,
    },
    singleDocumentRewrite: {
      segmentMs: segmentRewrite.durationMs,
      segmentBytes: segmentRewrite.value.byteLength,
      snapshotMs: snapshotRewrite.durationMs,
      snapshotBytes: snapshotRewrite.value.byteLength,
      binarySegmentMs: binarySegmentRewrite.durationMs,
      binarySegmentBytes:
        binarySegmentRewrite.value.byteLength,
    },
  };
}

function notes(count) {
  const rareCount = Math.max(1, Math.floor(count * 0.05));
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${String(index).padStart(6, "0")}`,
    title: `Note ${index % 50}`,
    category:
      index < rareCount
        ? "rare"
        : index < Math.floor(count / 2)
          ? "work"
          : "personal",
    body:
      `Deterministic note body ${index}. ` +
      `${"content ".repeat(18)}${index % 17}`,
    lastModified: index,
    bucket: `bucket-${String(index % 20).padStart(2, "0")}`,
    active: index % 5 !== 0,
  }));
}

function sampledIds(documents) {
  const samples =
    documents.length <= 1_000
      ? 100
      : documents.length <= 10_000
        ? 30
        : 10;
  return Array.from(
    { length: Math.min(samples, documents.length) },
    (_, index) =>
      documents[(index * 977) % documents.length].id,
  );
}

function configuredSizes() {
  const configured = process.env.THIMBLE_SEGMENT_SIZES;
  if (!configured) {
    return [128, 1_000, 10_000];
  }
  const values = configured
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(
      (value) =>
        Number.isInteger(value) &&
        value > 0 &&
        value <= 100_000,
    );
  if (values.length === 0) {
    throw new Error(
      "THIMBLE_SEGMENT_SIZES must contain positive integers up to 100000",
    );
  }
  return values;
}

async function measure(operation) {
  const started = performance.now();
  const value = await operation();
  return {
    durationMs: Number(
      (performance.now() - started).toFixed(3),
    ),
    value,
  };
}

function assertCount(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} returned ${actual}; expected ${expected}`,
    );
  }
}

function ratio(value, baseline) {
  return Number((value / baseline).toFixed(3));
}

function percent(value, total) {
  return Number(((value / total) * 100).toFixed(2));
}

function perOperation(duration, operations) {
  return Number((duration / operations).toFixed(4));
}

async function benchmarkFilePoints(segment, pointIds) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "thimble-segment-benchmark-"),
  );
  const filePath = path.join(directory, "notes.tis");
  try {
    await writeFile(filePath, segment);
    const source = await FileIndexedSegmentSource.open(filePath);
    try {
      const reader = await IndexedSegmentReader.open(source, {
        cacheBlocks: false,
      });
      source.resetMetrics();
      const measured = await measure(async () => {
        for (const id of pointIds) {
          const document = await reader.get(id);
          if (!document || document.id !== id) {
            throw new Error(`File indexed segment missed ${id}`);
          }
        }
      });
      return {
        samples: pointIds.length,
        durationMs: measured.durationMs,
        durationPerReadMs: perOperation(
          measured.durationMs,
          pointIds.length,
        ),
        rangeReads: source.reads,
        bytesRead: source.bytesRead,
        bytesPerRead: Math.round(
          source.bytesRead / pointIds.length,
        ),
      };
    } finally {
      await source.close();
    }
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}

async function benchmarkHttpPoints(segment, pointIds) {
  const connectedFetch = rangeFetch(segment);
  const connected = await measure(async () => {
    const connectedSource =
      await HttpIndexedSegmentSource.open(
      "https://benchmark.example/notes.tis",
      { fetch: connectedFetch.fetcher },
    );
    const connectedReader = await IndexedSegmentReader.open(
      connectedSource,
      { cacheBlocks: false },
    );
    for (const id of pointIds) {
      const document = await connectedReader.get(id);
      if (!document || document.id !== id) {
        throw new Error(`HTTP indexed segment missed ${id}`);
      }
    }
  });

  const cold = await measure(async () => {
    let requests = 0;
    let bytes = 0;
    for (const id of pointIds) {
      const simulated = rangeFetch(segment);
      const source = await HttpIndexedSegmentSource.open(
        "https://benchmark.example/notes.tis",
        { fetch: simulated.fetcher },
      );
      const reader = await IndexedSegmentReader.open(source, {
        cacheBlocks: false,
      });
      const document = await reader.get(id);
      if (!document || document.id !== id) {
        throw new Error(
          `Cold HTTP indexed segment missed ${id}`,
        );
      }
      requests += simulated.requests;
      bytes += simulated.bytes;
    }
    return { requests, bytes };
  });

  return {
    connected: {
      samples: pointIds.length,
      durationMs: connected.durationMs,
      durationPerReadMs: perOperation(
        connected.durationMs,
        pointIds.length,
      ),
      requests: connectedFetch.requests,
      requestsPerRead: ratio(
        connectedFetch.requests,
        pointIds.length,
      ),
      bytesRead: connectedFetch.bytes,
      bytesPerRead: Math.round(
        connectedFetch.bytes / pointIds.length,
      ),
    },
    cold: {
      samples: pointIds.length,
      durationMs: cold.durationMs,
      durationPerReadMs: perOperation(
        cold.durationMs,
        pointIds.length,
      ),
      requests: cold.value.requests,
      requestsPerRead: ratio(
        cold.value.requests,
        pointIds.length,
      ),
      bytesRead: cold.value.bytes,
      bytesPerRead: Math.round(
        cold.value.bytes / pointIds.length,
      ),
    },
  };
}

function rangeFetch(segment) {
  let requests = 0;
  let bytes = 0;
  return {
    get requests() {
      return requests;
    },
    get bytes() {
      return bytes;
    },
    async fetcher(_input, init) {
      const range = new Headers(init?.headers).get("range");
      const suffix = /^bytes=-(\d+)$/.exec(range ?? "");
      const explicit = /^bytes=(\d+)-(\d+)$/.exec(
        range ?? "",
      );
      if (!suffix && !explicit) {
        return new Response(null, { status: 400 });
      }
      const start = suffix
        ? Math.max(
            0,
            segment.byteLength - Number(suffix[1]),
          )
        : Number(explicit[1]);
      const end = suffix
        ? segment.byteLength - 1
        : Number(explicit[2]);
      const body = segment.slice(start, end + 1);
      requests += 1;
      bytes += body.byteLength;
      return new Response(body, {
        status: 206,
        headers: {
          "content-range":
            `bytes ${start}-${end}/${segment.byteLength}`,
        },
      });
    },
  };
}

async function createBenchmarkKeys() {
  const raw = Uint8Array.from(
    { length: 32 },
    (_, index) => index + 11,
  );
  return {
    encryptionKey: await importAesGcmKey(
      raw,
      ["encrypt", "decrypt"],
    ),
    fingerprintKey: await crypto.subtle.importKey(
      "raw",
      raw,
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    ),
  };
}
