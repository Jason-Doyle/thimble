import type { JsonValue } from "./core.js";
import type { TrieStoredDocument } from "./trie-protocol.js";

export type CollectionLayout = "trie" | "snapshot";

export type SnapshotHead = {
  revision: number;
  snapshotHash: string | null;
};

export type SnapshotPage = {
  documents: Record<string, TrieStoredDocument>;
};

export type SnapshotBundleObject = {
  key: string;
  etag: string;
  value: JsonValue;
};

export function snapshotCollectionPrefix(
  collection: string,
): string {
  return `content-snapshot/${collection}`;
}

export function snapshotHeadKey(collection: string): string {
  return `${snapshotCollectionPrefix(collection)}/HEAD.json`;
}

export function snapshotPageKey(
  collection: string,
  hash: string,
): string {
  return `${snapshotCollectionPrefix(collection)}/snapshots/${hash}.json`;
}
