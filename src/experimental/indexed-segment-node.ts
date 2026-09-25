import {
  open,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type {
  IndexedSegmentSource,
} from "./indexed-segment.js";

export class FileIndexedSegmentSource
implements IndexedSegmentSource {
  reads = 0;
  bytesRead = 0;

  private constructor(
    private readonly handle: FileHandle,
    readonly byteLength: number,
  ) {}

  static async open(
    filePath: string,
  ): Promise<FileIndexedSegmentSource> {
    const resolved = path.resolve(filePath);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) {
      throw new Error(
        "Indexed segment source must be a regular file",
      );
    }
    const handle = await open(resolved, "r");
    return new FileIndexedSegmentSource(
      handle,
      metadata.size,
    );
  }

  async read(
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.byteLength
    ) {
      throw new Error("Indexed segment file range is invalid");
    }
    const bytes = new Uint8Array(length);
    let consumed = 0;
    while (consumed < length) {
      const result = await this.handle.read(
        bytes,
        consumed,
        length - consumed,
        offset + consumed,
      );
      if (result.bytesRead === 0) {
        throw new Error(
          "Indexed segment file ended during a range read",
        );
      }
      consumed += result.bytesRead;
    }
    this.reads += 1;
    this.bytesRead += bytes.byteLength;
    return bytes;
  }

  resetMetrics(): void {
    this.reads = 0;
    this.bytesRead = 0;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}
