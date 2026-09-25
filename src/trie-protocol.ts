import type { JsonDocument, JsonValue } from "./core.js";
import type { SecondaryIndexReferences } from "./secondary-index.js";

export type TrieRootNode = {
  kind: "root";
  children: Record<string, string>;
};

export type TrieBranchNode = {
  kind: "branch";
  children: Record<string, string>;
  leafMetadata?: Record<string, TrieLeafMetadata>;
};

export type TrieLeafMetadata = {
  records: number;
  tombstones: number;
  decodedBytes: number;
};

export type TrieLeafNode = {
  kind: "leaf";
  documents: Record<string, TrieStoredDocument>;
};

export type TrieTombstone = {
  id: string;
  __thimbleTombstone: {
    deletedAt: string;
    restoreUntil: string;
    purgeAfter: string;
  };
  document: JsonDocument;
};

export type TrieStoredDocument =
  | JsonDocument
  | TrieTombstone;

export type TrieNode =
  | TrieRootNode
  | TrieBranchNode
  | TrieLeafNode;

export type TrieHead = {
  revision: number;
  rootHash: string | null;
  indexes?: SecondaryIndexReferences;
};

export type TrieBundleObject = {
  key: string;
  etag: string;
  value: JsonValue;
};

export type TrieReadBundle = {
  collection: string;
  id: string;
  revision: number;
  document: JsonDocument | null;
  objects: TrieBundleObject[];
  layout?: "trie" | "snapshot";
};

export type ReadBundleLimits = {
  maxObjects: number;
  maxDecodedBytes: number;
};

export function trieCollectionPrefix(collection: string): string {
  return `content-trie/${collection}`;
}

export function trieHeadKey(collection: string): string {
  return `${trieCollectionPrefix(collection)}/HEAD.json`;
}

export function trieNodeKey(
  collection: string,
  hash: string,
): string {
  return `${trieCollectionPrefix(collection)}/nodes/${hash}.json`;
}

export function trieIndexKey(
  collection: string,
  indexName: string,
  hash: string,
): string {
  return `${trieCollectionPrefix(collection)}/indexes/${encodeURIComponent(indexName)}/${hash}.json`;
}

export function triePathFromHash(hash: string): [string, string] {
  return [hash[0] ?? "0", hash[1] ?? "0"];
}

export function scopeStoragePrefix(scopeId: string): string {
  return `scopes/${encodeURIComponent(scopeId)}`;
}

export function isTrieTombstone(
  value: TrieStoredDocument,
): value is TrieTombstone {
  return (
    "__thimbleTombstone" in value &&
    typeof value.__thimbleTombstone === "object" &&
    value.__thimbleTombstone !== null
  );
}

export function visibleTrieDocument(
  value: TrieStoredDocument | undefined,
): JsonDocument | null {
  return value && !isTrieTombstone(value) ? value : null;
}
