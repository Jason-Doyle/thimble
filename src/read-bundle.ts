import type {
  ContentAddressedTrieEngine,
} from "./engines/content-trie.js";
import type {
  ImmutableSnapshotEngine,
} from "./engines/immutable-snapshot.js";
import type { JsonValue } from "./core.js";
import { encodeJson } from "./shared-utils.js";
import { BoundedReadError } from "./core.js";
import type { TrieReadBundle } from "./trie-protocol.js";

export const READ_BUNDLE_MAX_OBJECTS = 4;
export const READ_BUNDLE_MAX_DECODED_BYTES =
  4 * 1024 * 1024;

type ReadBundleEngine =
  | ContentAddressedTrieEngine
  | ImmutableSnapshotEngine;

export function readPointBundle(
  engine: ReadBundleEngine,
  collection: string,
  id: string,
): Promise<TrieReadBundle> {
  return engine.readBundle(collection, id, {
    maxObjects: READ_BUNDLE_MAX_OBJECTS,
    maxDecodedBytes: READ_BUNDLE_MAX_DECODED_BYTES,
  }).then((bundle) => {
    if (
      encodeJson(bundle as unknown as JsonValue).byteLength >
      READ_BUNDLE_MAX_DECODED_BYTES
    ) {
      throw new BoundedReadError(
        `Read bundle response exceeds ${READ_BUNDLE_MAX_DECODED_BYTES} decoded bytes`,
      );
    }
    return bundle;
  });
}
