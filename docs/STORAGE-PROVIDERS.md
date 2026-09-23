# Storage providers

Object storage is an implementation layer beneath the ThimbleDB protocol. The
browser cache, envelope format, trie, key scopes, and write semantics do not
depend on one cloud.

## Provider contract

Every provider implements four operations:

```ts
interface ObjectStore {
  get(key: string): Promise<StoredObject | null>
  put(
    key: string,
    bytes: Uint8Array,
    conditions?: {
      ifMatch?: string
      ifNoneMatch?: boolean
    }
  ): Promise<{ etag: string }>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}
```

The two conditional-write modes are load-bearing:

- create an immutable object only when its key does not already exist
- replace HEAD only when its current ETag matches

A provider that cannot enforce both operations atomically is not a safe
multi-writer backend.

## Supported providers

| Provider | Position | Write integration | Browser read integration |
| --- | --- | --- | --- |
| Cloudflare R2 | Preferred reference provider | Native Worker R2 binding | R2 custom domain, temporary credentials, or presigned URLs |
| Local filesystem | Development and single-process use | In-process file adapter | Same-origin `/objects` endpoint |
| Azure Blob Storage | Supported secondary provider | Azure SDK and conditional blob writes | Read-only SAS |
| Amazon S3 | Supported secondary provider | AWS SDK and IAM role | CloudFront, Cognito credentials, or a read broker |
| S3-compatible storage | Experimental compatibility | S3 endpoint adapter | Provider-specific |

## Cloudflare R2

R2 is the preferred provider because:

- Workers receive a native bucket binding without long-lived API credentials
- reads and writes are strongly consistent
- conditional R2 operations map directly to the protocol
- encrypted object reads can use a custom domain
- egress is free
- the free tier covers many small evaluation applications

Cloudflare-specific authentication and deployment do not change stored bytes.

## Local filesystem

The local provider stores object keys below `.thimble-data`. It is useful for:

- local browser development
- protocol tests
- benchmarks
- one Node process on one machine
- offline demonstrations

Its key locks exist only inside one Node process. Two independent processes can
race and violate compare-and-swap semantics. Do not use the current local
adapter for a multi-process or shared-network-filesystem deployment.

A future durable local provider could use SQLite, OS file locks, or another
transactional embedded store while preserving the ObjectStore interface.

## Azure Blob Storage

Azure maps protocol conditions to `If-None-Match` and `If-Match`. A direct
browser reader uses a read-only SAS URL and Blob-service CORS.

The Node authority currently uses a connection string. Managed identity is the
preferred production improvement.

## Amazon S3

S3 maps protocol conditions to conditional `PutObject`. The authority can use
an IAM role through the normal AWS credential chain.

CloudFront can expose encrypted objects while keeping the bucket private.
Cognito temporary credentials or signed CloudFront access can add a transport
authorisation layer.

## Adding a provider

Before describing a provider as supported:

1. Implement the ObjectStore contract.
2. Prove atomic create-if-absent.
3. Prove stale ETag replacement is rejected.
4. Verify strong read-after-write behaviour.
5. Verify ETag formatting on direct HTTP reads.
6. Run the engine contract tests.
7. Run concurrent-writer and maintenance benchmarks.
8. Document browser CORS and credential delivery.

API compatibility with S3 is not enough. Conditional and consistency semantics
must be tested.
