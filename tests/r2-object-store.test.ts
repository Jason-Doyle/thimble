import { describe, expect, it } from "vitest";
import { PreconditionFailedError } from "../src/core.js";
import {
  R2ObjectStore,
  type R2BucketBinding,
} from "../src/cloudflare/r2-object-store.js";

describe("R2ObjectStore", () => {
  it("maps object-store conditional writes to R2 onlyIf conditions", async () => {
    const conditions: unknown[] = [];
    const bucket: R2BucketBinding = {
      get: async () => null,
      async put(_key, _value, options) {
        conditions.push(options?.onlyIf);
        if (options?.onlyIf?.etagDoesNotMatch === "*") {
          return { etag: "created" };
        }
        if (options?.onlyIf?.etagMatches === "expected") {
          return { etag: "updated" };
        }
        return null;
      },
      delete: async () => undefined,
      list: async () => ({
        objects: [],
        truncated: false,
      }),
    };
    const store = new R2ObjectStore(bucket);

    await expect(
      store.put("new", new Uint8Array([1]), {
        ifNoneMatch: true,
      }),
    ).resolves.toEqual({ etag: '"created"' });
    await expect(
      store.put("existing", new Uint8Array([2]), {
        ifMatch: '"expected"',
      }),
    ).resolves.toEqual({ etag: '"updated"' });
    await expect(
      store.put("conflict", new Uint8Array([3]), {
        ifMatch: '"wrong"',
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    expect(conditions).toEqual([
      { etagDoesNotMatch: "*" },
      { etagMatches: "expected" },
      { etagMatches: "wrong" },
    ]);
  });
});
