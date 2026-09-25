# Configuration reference

ThimbleDB authorities can be configured through code options and environment
settings. Prefer code for collection layouts and indexes because it is easier
to type-check and review. Keep secrets in the deployment platform's secret
store.

Code options take precedence over matching environment settings.

## Authority code options

Both `startNodeAuthority()` and `createCloudflareAuthority()` accept:

| Option | Purpose | Default |
| --- | --- | --- |
| `collectionLayouts` | Explicit `trie` or `snapshot` layout by collection | Trie for collections not listed |
| `collectionIndexes` | Complete declared secondary-index definitions | No indexes |
| `collections` | Bounded Studio collection catalogue | Names inferred from configured layouts and indexes |
| `studio` | Enable Studio APIs and Node asset hosting | `false` |
| `studioOrigin` | Additional exact origin accepted for Studio mutations | Local Node authority origin when Studio is enabled; otherwise none |
| `readBundles` | Advertise bounded decoded point-read bundles | `false` |

## Common authority settings

These settings are supported by both the Node and Cloudflare authorities
unless noted otherwise.

| Setting | Purpose | Default or requirement |
| --- | --- | --- |
| `THIMBLE_MASTER_KEY` | Base64 deployment master key with at least 32 decoded bytes | Required outside the local Node provider; local Node creates a protected key file when absent |
| `THIMBLE_ALLOWED_ORIGIN` | Exact browser origin accepted for state-changing requests | Required except local Node, which defaults to `http://127.0.0.1:5173` |
| `THIMBLE_PREFIX` | Application prefix inside the data store | `demo` |
| `THIMBLE_KEY_VERSION` | Active scope-key version for writes | `1` |
| `THIMBLE_READ_KEY_VERSIONS` | Comma-separated historical key versions that remain readable | Empty |
| `THIMBLE_HEAD_TTL_MS` | Browser mutable-HEAD revalidation interval | `1000` |
| `THIMBLE_COLLECTION_LAYOUTS` | Comma-separated `collection=trie|snapshot` mappings | Empty; trie is the fallback |
| `THIMBLE_COLLECTION_INDEXES` | JSON object containing the complete active index definitions | `{}` |
| `THIMBLE_DELETE_RETENTION_DAYS` | Restore window for retained deletions | `30` |
| `THIMBLE_DELETE_GRACE_DAYS` | Additional delay before expired tombstones leave the live layout | `7` |
| `THIMBLE_MAINTENANCE_MODE` | Reject normal writes while maintenance is running | `false` |
| `THIMBLE_STUDIO` | Enable Studio | `false` |
| `THIMBLE_STUDIO_ORIGIN` | Additional exact Studio origin | None, except local Node defaults to its authority origin |
| `THIMBLE_COLLECTIONS` | Comma-separated Studio collection catalogue | Empty |
| `THIMBLE_READ_BUNDLES` | Enable the trusted-authority decoded bundle path | `false` |

`THIMBLE_READ_BUNDLES=true` changes the read transport trust boundary. Review
[Security](SECURITY.md) before enabling it.

## Identity settings

Configure at least one production OIDC provider.

Microsoft Entra:

| Setting | Purpose |
| --- | --- |
| `ENTRA_TENANT_ID` | Exact Entra tenant |
| `ENTRA_AUDIENCE` | API audience |
| `ENTRA_REQUIRED_SCOPE` | Optional required delegated scope |
| `ENTRA_REQUIRED_ROLE` | Optional required application role |

Generic OIDC:

| Setting | Purpose |
| --- | --- |
| `OIDC_PROVIDER_ID` | Stable route-safe provider identifier |
| `OIDC_ISSUER` | Exact token issuer |
| `OIDC_AUDIENCE` | Required audience |
| `OIDC_JWKS_URI` | HTTPS JWKS endpoint |
| `OIDC_ALLOWED_TENANTS` | Optional comma-separated tenant allowlist |
| `OIDC_REQUIRED_SCOPE` | Optional required delegated scope |
| `OIDC_REQUIRED_ROLE` | Optional required application role |

At least one required scope or role must be configured for each provider.
When both are set, both must be present.

## Node-only runtime settings

| Setting | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | Process mode used to prohibit the local development identity in production | Unset |
| `THIMBLE_PROVIDER` | Object-store adapter: `local`, `azure`, `s3`, or `r2` | `azure` when `AZURE_STORAGE_CONNECTION_STRING` is set; otherwise `local` |
| `THIMBLE_HOST` | Authority listen address | `127.0.0.1` |
| `THIMBLE_PORT` | Authority listen port | `8787` |
| `THIMBLE_SECURE_COOKIES` | Force Secure session cookies | `true` for cloud providers; otherwise `false` unless explicitly enabled |
| `THIMBLE_SESSION_TTL_SECONDS` | Opaque session lifetime | `3600` |
| `THIMBLE_AUTH_RATE_LIMIT` | Authentication attempts per durable rate window | `5` |
| `THIMBLE_AUTH_RATE_WINDOW_MS` | Authentication rate window | `60000` |
| `THIMBLE_SCOPE_CACHE_MAX` | Maximum cached scope runtimes | `100` |
| `THIMBLE_SCOPE_CACHE_TTL_MS` | Scope-runtime cache lifetime | `900000` |
| `THIMBLE_TRUSTED_PROXY_IPS` | Comma-separated immediate proxy addresses trusted for `X-Forwarded-For` | Empty |
| `THIMBLE_DISABLE_IP_RATE_LIMIT` | Disable source-IP limiting when the proxy boundary cannot be verified | `false` |

## Local Node settings

| Setting | Purpose | Default |
| --- | --- | --- |
| `THIMBLE_LOCAL_DATA_ROOT` | Local application-object directory | `.thimble-data` |
| `THIMBLE_LOCAL_AUTH_ROOT` | Local authentication-object directory | `.thimble-auth` |
| `THIMBLE_LOCAL_SECRET_ROOT` | Local master-key directory | `.thimble-data` |
| `THIMBLE_DEV_IDENTITY` | Enable the loopback-only development identity | `false` |
| `THIMBLE_DEV_SUBJECT` | Development identity subject | `local-developer` |
| `THIMBLE_DEV_DISPLAY_NAME` | Development identity display name | `Local developer` |

The development identity requires a local provider, a non-production process,
a loopback listen host, and loopback application and Studio origins.

## Node provider settings

Azure Blob Storage:

| Setting | Purpose | Default |
| --- | --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | Server-only Blob Storage connection string | Required |
| `AZURE_STORAGE_CONTAINER` | Data container | `thimbledb` |
| `AZURE_AUTH_STORAGE_CONTAINER` | Authentication container | `<data-container>-auth` |

Amazon S3:

| Setting | Purpose | Default |
| --- | --- | --- |
| `S3_BUCKET` | Data bucket | Required |
| `S3_AUTH_BUCKET` | Authentication bucket | Required |
| `AWS_REGION` | AWS region used by the SDK | `us-east-1` |
| `S3_ENDPOINT` | Optional S3-compatible endpoint | AWS endpoint |
| `S3_FORCE_PATH_STYLE` | Use path-style bucket addressing | `false` |

The AWS SDK uses its normal credential chain.

R2 through the S3 adapter:

| Setting | Purpose |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET` | Data bucket |
| `R2_AUTH_BUCKET` | Authentication bucket |
| `R2_ACCESS_KEY_ID` | R2 API access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 API secret |

Prefer the native Worker bindings for the Cloudflare reference deployment.

## Cloudflare bindings

| Binding | Purpose | Required |
| --- | --- | --- |
| `DB` | Private R2 data bucket | Yes |
| `AUTH_DB` | Separate private R2 authentication bucket | Yes |
| `ASSETS` | Static application and Studio assets | Optional |
| `AUTH_RATE_LIMITER` | Native low-latency source-IP rate limit | Optional |

Cloudflare uses a one-hour session lifetime and a bounded in-memory scope
runtime cache. Those values are not environment-configurable in the current
Worker authority.

## Maintenance command settings

These settings apply to command-line maintenance. They are not all authority
runtime settings.

| Setting | Purpose |
| --- | --- |
| `THIMBLE_SCOPE_ID` | Target scope |
| `THIMBLE_COLLECTIONS` | Target collection list |
| `THIMBLE_COLLECTION` | Single collection for a layout migration |
| `THIMBLE_SOURCE_LAYOUT` | Existing `trie` or `snapshot` layout for a layout migration |
| `THIMBLE_TARGET_LAYOUT` | Replacement `trie` or `snapshot` layout for a layout migration |
| `THIMBLE_COLLECTION_LAYOUTS` | Active layout mapping |
| `THIMBLE_RETIRED_COLLECTION_LAYOUTS` | Retired layouts eligible for quiescent cleanup |
| `THIMBLE_COLLECTION_INDEXES` | Complete active index definitions |
| `THIMBLE_MIGRATION_QUIESCENT` | Confirms writes are blocked for migration commands |
| `THIMBLE_MAINTENANCE_QUIESCENT` | Confirms writes are blocked for destructive retention maintenance |

Do not add `THIMBLE_RETIRED_COLLECTION_LAYOUTS` to a Worker and expect it to
perform cleanup. Run the documented maintenance command in a controlled
environment with the matching provider credentials and master key.

## Supplied template coverage

The Cloudflare Wrangler example exposes current collection, Studio, and
read-bundle settings.

The checked-in Azure and AWS infrastructure templates intentionally expose a
smaller core setting set. Their deployment guides list the optional settings
that require a reviewed derived template. Do not assume a shell variable is
passed into Container Apps or Lambda unless the infrastructure template maps
it into the container environment.
