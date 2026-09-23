import type {
  DatabaseEngine,
  EngineDiagnostics,
  JsonDocument,
  JsonValue,
  ObjectStore,
  StoredObject,
} from "../core.js";
import {
  createDictionary,
  decodeJson,
  encodeJson,
  isPreconditionFailure,
  ownValue,
  validateName,
} from "../shared-utils.js";
import {
  trieCollectionPrefix,
  trieHeadKey,
  trieNodeKey,
  triePathFromHash,
  type TrieBranchNode,
  type TrieHead,
  type TrieLeafNode,
  type TrieNode,
  type TrieReadBundle,
  type TrieRootNode,
} from "../trie-protocol.js";

type LoadedHead = {
  object: StoredObject | null;
  state: TrieHead;
};

type TrieUpdate = {
  id: string;
  document: JsonDocument;
  first: string;
  second: string;
};

export class ContentAddressedTrieEngine implements DatabaseEngine {
  readonly name = "content-addressed-trie";
  private casRetries = 0;
  private nodesCreated = 0;
  private reusedNodes = 0;
  private garbageCollected = 0;

  constructor(
    private readonly store: ObjectStore,
    private readonly maxRetries = 40,
    private readonly addressNode: (
      bytes: Uint8Array,
    ) => Promise<string> | string = hashBytes,
  ) {}

  async get(
    collection: string,
    id: string,
  ): Promise<JsonDocument | null> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    if (head.state.rootHash === null) {
      return null;
    }

    const [first, second] = await this.pathFor(id);
    const root = await this.readNode<TrieRootNode>(
      normalized,
      head.state.rootHash,
      "root",
    );
    const branchHash = root.children[first];
    if (!branchHash) {
      return null;
    }
    const branch = await this.readNode<TrieBranchNode>(
      normalized,
      branchHash,
      "branch",
    );
    const leafHash = branch.children[second];
    if (!leafHash) {
      return null;
    }
    const leaf = await this.readNode<TrieLeafNode>(
      normalized,
      leafHash,
      "leaf",
    );
    return ownValue(leaf.documents, id) ?? null;
  }

  async scan(collection: string): Promise<JsonDocument[]> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    if (head.state.rootHash === null) {
      return [];
    }

    const root = await this.readNode<TrieRootNode>(
      normalized,
      head.state.rootHash,
      "root",
    );
    const branchEntries = Object.entries(root.children).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const branchDocuments = await Promise.all(
      branchEntries.map(async ([, branchHash]) => {
        const branch = await this.readNode<TrieBranchNode>(
          normalized,
          branchHash,
          "branch",
        );
        const leafEntries = Object.entries(branch.children).sort(
          ([left], [right]) => left.localeCompare(right),
        );
        const leaves = await Promise.all(
          leafEntries.map(([, leafHash]) =>
            this.readNode<TrieLeafNode>(
              normalized,
              leafHash,
              "leaf",
            ),
          ),
        );
        return leaves.flatMap((leaf) => Object.values(leaf.documents));
      }),
    );

    return branchDocuments
      .flat()
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  put(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<void> {
    return this.putMany(collection, [{ ...document, id }]);
  }

  async putMany(
    collection: string,
    documents: JsonDocument[],
  ): Promise<void> {
    const normalized = validateName(collection, "Collection");
    const updates = await Promise.all(
      documents.map(async (document) => {
        const [first, second] = await this.pathFor(document.id);
        return {
          id: document.id,
          document: structuredClone(document),
          first,
          second,
        };
      }),
    );

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const head = await this.loadHead(normalized);
      const root =
        head.state.rootHash === null
          ? this.emptyRoot()
          : await this.readNode<TrieRootNode>(
              normalized,
              head.state.rootHash,
              "root",
            );
      const nextRoot: TrieRootNode = {
        kind: "root",
        children: { ...root.children },
      };

      const byBranch = groupUpdates(updates);
      const changedBranches = await Promise.all(
        [...byBranch].map(async ([first, byLeaf]) => {
          const currentBranchHash = root.children[first];
          const currentBranch = currentBranchHash
            ? await this.readNode<TrieBranchNode>(
                normalized,
                currentBranchHash,
                "branch",
              )
            : this.emptyBranch();
          const nextBranch: TrieBranchNode = {
            kind: "branch",
            children: { ...currentBranch.children },
          };

          const changedLeaves = await Promise.all(
            [...byLeaf].map(async ([second, leafUpdates]) => {
              const currentLeafHash = currentBranch.children[second];
              const currentLeaf = currentLeafHash
                ? await this.readNode<TrieLeafNode>(
                    normalized,
                    currentLeafHash,
                    "leaf",
                  )
                : this.emptyLeaf();
              const nextLeaf: TrieLeafNode = {
                kind: "leaf",
                documents: createDictionary(
                  currentLeaf.documents,
                ),
              };
              for (const update of leafUpdates) {
                nextLeaf.documents[update.id] = update.document;
              }
              return [
                second,
                await this.writeNode(normalized, nextLeaf),
              ] as const;
            }),
          );
          for (const [second, leafHash] of changedLeaves) {
            nextBranch.children[second] = leafHash;
          }

          return [
            first,
            await this.writeNode(normalized, nextBranch),
          ] as const;
        }),
      );
      for (const [first, branchHash] of changedBranches) {
        nextRoot.children[first] = branchHash;
      }

      const rootHash = await this.writeNode(normalized, nextRoot);
      const nextHead: TrieHead = {
        revision: head.state.revision + 1,
        rootHash,
      };

      try {
        await this.store.put(
          this.headKey(normalized),
          encodeJson(nextHead as unknown as JsonValue),
          head.object === null
            ? { ifNoneMatch: true }
            : { ifMatch: head.object.etag },
        );
        return;
      } catch (error) {
        if (!isPreconditionFailure(error)) {
          throw error;
        }
        this.casRetries += 1;
      }
    }

    throw new Error(
      `Content-addressed trie write exceeded ${this.maxRetries} retries`,
    );
  }

  async compact(collection: string): Promise<void> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    const reachable = new Set<string>();

    if (head.state.rootHash !== null) {
      reachable.add(head.state.rootHash);
      const root = await this.readNode<TrieRootNode>(
        normalized,
        head.state.rootHash,
        "root",
      );
      const branches = await Promise.all(
        Object.values(root.children).map(async (branchHash) => {
          const branch = await this.readNode<TrieBranchNode>(
            normalized,
            branchHash,
            "branch",
          );
          return { branchHash, branch };
        }),
      );
      for (const { branchHash, branch } of branches) {
        reachable.add(branchHash);
        Object.values(branch.children).forEach((leafHash) =>
          reachable.add(leafHash),
        );
      }
    }

    const nodePrefix = `${this.collectionPrefix(normalized)}/nodes/`;
    const keys = await this.store.list(nodePrefix);
    const staleKeys = keys.filter((key) => {
      const fileName = key.slice(nodePrefix.length);
      const hash = fileName.replace(/\.json$/, "");
      return !reachable.has(hash);
    });
    await Promise.all(staleKeys.map((key) => this.store.delete(key)));
    this.garbageCollected += staleKeys.length;
  }

  diagnostics(): EngineDiagnostics {
    return {
      casRetries: this.casRetries,
      nodesCreated: this.nodesCreated,
      reusedNodes: this.reusedNodes,
      garbageCollected: this.garbageCollected,
    };
  }

  async readBundle(
    collection: string,
    id: string,
  ): Promise<TrieReadBundle> {
    const normalized = validateName(collection, "Collection");
    const head = await this.loadHead(normalized);
    const objects = [];

    if (head.object !== null) {
      objects.push({
        key: trieHeadKey(normalized),
        etag: head.object.etag,
        value: head.state as unknown as JsonValue,
      });
    }

    if (head.state.rootHash === null) {
      return {
        collection: normalized,
        id,
        revision: head.state.revision,
        document: null,
        objects,
      };
    }

    const [first, second] = await this.pathFor(id);
    const root = await this.loadNodeObject<TrieRootNode>(
      normalized,
      head.state.rootHash,
      "root",
    );
    objects.push({
      key: trieNodeKey(normalized, head.state.rootHash),
      etag: root.object.etag,
      value: root.value as unknown as JsonValue,
    });
    const branchHash = root.value.children[first];
    if (!branchHash) {
      return {
        collection: normalized,
        id,
        revision: head.state.revision,
        document: null,
        objects,
      };
    }

    const branch = await this.loadNodeObject<TrieBranchNode>(
      normalized,
      branchHash,
      "branch",
    );
    objects.push({
      key: trieNodeKey(normalized, branchHash),
      etag: branch.object.etag,
      value: branch.value as unknown as JsonValue,
    });
    const leafHash = branch.value.children[second];
    if (!leafHash) {
      return {
        collection: normalized,
        id,
        revision: head.state.revision,
        document: null,
        objects,
      };
    }

    const leaf = await this.loadNodeObject<TrieLeafNode>(
      normalized,
      leafHash,
      "leaf",
    );
    objects.push({
      key: trieNodeKey(normalized, leafHash),
      etag: leaf.object.etag,
      value: leaf.value as unknown as JsonValue,
    });

    return {
      collection: normalized,
      id,
      revision: head.state.revision,
      document: ownValue(leaf.value.documents, id) ?? null,
      objects,
    };
  }

  private async loadHead(collection: string): Promise<LoadedHead> {
    const object = await this.store.get(trieHeadKey(collection));
    if (object === null) {
      return {
        object,
        state: { revision: 0, rootHash: null },
      };
    }
    return { object, state: decodeJson<TrieHead>(object.bytes) };
  }

  private async writeNode(
    collection: string,
    node: TrieNode,
  ): Promise<string> {
    const bytes = encodeJson(node as unknown as JsonValue);
    const hash = await this.addressNode(bytes);
    try {
      await this.store.put(this.nodeKey(collection, hash), bytes, {
        ifNoneMatch: true,
      });
      this.nodesCreated += 1;
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      this.reusedNodes += 1;
    }
    return hash;
  }

  private async readNode<T extends TrieNode>(
    collection: string,
    hash: string,
    expectedKind: T["kind"],
  ): Promise<T> {
    return (
      await this.loadNodeObject<T>(collection, hash, expectedKind)
    ).value;
  }

  private async loadNodeObject<T extends TrieNode>(
    collection: string,
    hash: string,
    expectedKind: T["kind"],
  ): Promise<{ object: StoredObject; value: T }> {
    const object = await this.store.get(trieNodeKey(collection, hash));
    if (object === null) {
      throw new Error(`Trie node ${hash} is missing`);
    }
    const node = decodeJson<TrieNode>(object.bytes);
    if (node.kind !== expectedKind) {
      throw new Error(
        `Trie node ${hash} is ${node.kind}, expected ${expectedKind}`,
      );
    }
    return { object, value: node as T };
  }

  private async pathFor(id: string): Promise<[string, string]> {
    return triePathFromHash(
      await hashBytes(new TextEncoder().encode(id)),
    );
  }

  private emptyRoot(): TrieRootNode {
    return { kind: "root", children: {} };
  }

  private emptyBranch(): TrieBranchNode {
    return { kind: "branch", children: {} };
  }

  private emptyLeaf(): TrieLeafNode {
    return { kind: "leaf", documents: createDictionary() };
  }

  private collectionPrefix(collection: string): string {
    return trieCollectionPrefix(collection);
  }

  private headKey(collection: string): string {
    return trieHeadKey(collection);
  }

  private nodeKey(collection: string, hash: string): string {
    return trieNodeKey(collection, hash);
  }
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function groupUpdates(
  updates: TrieUpdate[],
): Map<string, Map<string, TrieUpdate[]>> {
  const branches = new Map<string, Map<string, TrieUpdate[]>>();
  for (const update of updates) {
    let leaves = branches.get(update.first);
    if (!leaves) {
      leaves = new Map<string, TrieUpdate[]>();
      branches.set(update.first, leaves);
    }
    const leafUpdates = leaves.get(update.second) ?? [];
    leafUpdates.push(update);
    leaves.set(update.second, leafUpdates);
  }
  return branches;
}
