import type { JsonDocument, JsonValue } from "./core.js";

export type TrieRootNode = {
  kind: "root";
  children: Record<string, string>;
};

export type TrieBranchNode = {
  kind: "branch";
  children: Record<string, string>;
};

export type TrieLeafNode = {
  kind: "leaf";
  documents: Record<string, JsonDocument>;
};

export type TrieNode =
  | TrieRootNode
  | TrieBranchNode
  | TrieLeafNode;

export type TrieHead = {
  revision: number;
  rootHash: string | null;
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

export function triePathFromHash(hash: string): [string, string] {
  return [hash[0] ?? "0", hash[1] ?? "0"];
}

export function scopeStoragePrefix(scopeId: string): string {
  return `scopes/${encodeURIComponent(scopeId)}`;
}
