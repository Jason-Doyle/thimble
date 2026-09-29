# Deploy to Kubernetes

ThimbleDB can run as a separate Node authority in Kubernetes. The release
distribution consists of:

- a multi-architecture image at `ghcr.io/jason-doyle/thimbledb`
- an OCI Helm chart at `oci://ghcr.io/jason-doyle/charts/thimbledb`

The chart deploys only the authority. It does not provision object storage,
an OIDC application, DNS, certificates, or cloud credentials.

Use Kubernetes when the application already has a cluster and needs a
separate authority deployment, secret boundary, rollout, or scaling policy.
For one small application without an existing cluster, an in-app authority or
managed Worker is normally a smaller operational surface.

## Requirements

- Kubernetes 1.28 or newer
- Helm 3.18 or newer
- one private S3, R2, or Azure Blob data store
- one separate private authentication bucket or container
- an external OIDC provider
- a Kubernetes Secret containing the deployment master key and provider
  settings
- an existing gateway or Ingress that preserves the browser application's
  public origin

The chart is validated in CI with Helm 3.18.3, kind 0.33.0, and Kubernetes
1.37.0. It also renders with Helm 4.3.0.

## Prepare the Secret

Create the namespace and Secret before installing the chart. Keep the source
secret file outside the repository and remove it after the platform secret
workflow has imported it.

```powershell
kubectl create namespace thimbledb
kubectl --namespace thimbledb create secret generic thimbledb-secrets `
  --from-env-file=C:\secure\thimbledb-secrets.env
```

Every deployment needs:

| Setting | Purpose |
| --- | --- |
| `THIMBLE_MASTER_KEY` | Base64 deployment master key with at least 32 decoded bytes |

Add the settings for the selected provider:

| Provider | Secret settings |
| --- | --- |
| S3 | `S3_BUCKET`, `S3_AUTH_BUCKET`, and credentials accepted by the AWS SDK |
| R2 | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_AUTH_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| Azure | `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER`, `AZURE_AUTH_STORAGE_CONTAINER` |

Cloud workload identity can replace long-lived provider access keys. Annotate
the ServiceAccount as required by the platform and explicitly set
`serviceAccount.automount: true`. The default is `false`. The existing Secret
still holds `THIMBLE_MASTER_KEY` and non-credential provider settings.

Do not put credentials or the master key in a values file, ConfigMap, rendered
manifest, or container image.

## Configure values

Copy `deploy/helm/thimbledb/values.example.yaml` and uncomment only the
required settings. The checked-in example is fully commented so applying it
cannot create an accidentally configured deployment.

The minimum production shape is:

```yaml
# existingSecret: thimbledb-secrets
#
# config:
#   provider: s3
#   allowedOrigin: https://app.example.com
#   prefix: production
#   collectionLayouts: notes=snapshot
#   readBundles: true
#   mutationBatches: true
#   oidc:
#     providerId: application
#     issuer: https://identity.example.com/
#     audience: thimbledb-api
#     jwksUri: https://identity.example.com/.well-known/jwks.json
#     requiredScope: thimble.access
```

The generic OIDC block requires `providerId`, `issuer`, `audience`, `jwksUri`,
and at least one required scope or role. Microsoft Entra settings can instead
be supplied through the existing Secret.

## Install

Chart and application versions remain aligned. Install an exact version:

```powershell
helm upgrade --install thimbledb `
  oci://ghcr.io/jason-doyle/charts/thimbledb `
  --version 3.3.0 `
  --namespace thimbledb `
  --values .\thimbledb-values.yaml `
  --wait `
  --timeout 5m
```

The chart uses `ghcr.io/jason-doyle/thimbledb:<appVersion>` by default. Set
`image.digest` to an immutable `sha256:` digest when the deployment requires
digest pinning. A configured digest takes precedence over `image.tag`.

## Preserve one browser origin

Ingress creation is disabled by default. Route the authority through the
application's existing gateway:

```text
https://app.example.com/           -> application
https://app.example.com/api/*      -> service/thimbledb:8787
https://app.example.com/studio/*   -> service/thimbledb:8787, when enabled
```

The default session cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.
`config.allowedOrigin` must be the exact public application origin. A separate
Kubernetes Service must not automatically become a separate browser origin.

The chart can create an Ingress when `ingress.enabled=true`, but it does not
create certificates or DNS records. Keep the option disabled when an existing
application gateway already owns these paths.

## Security defaults

The default Pod:

- runs as UID and GID 1000
- requires a non-root process
- uses `RuntimeDefault` seccomp
- drops every Linux capability
- blocks privilege escalation
- uses a read-only root filesystem
- mounts a writable `emptyDir` only at `/tmp`
- does not mount a ServiceAccount token
- loads credentials only from `existingSecret`

The chart defaults to one replica and the `Recreate` deployment strategy.
`Recreate` avoids running mixed authority versions during an upgrade, at the
cost of a short outage. Change the strategy only after checking release
compatibility and migration requirements.

## Health and readiness

The authority exposes two unauthenticated probe routes:

| Route | Meaning |
| --- | --- |
| `GET /healthz` | The process is serving requests |
| `GET /readyz` | Authority initialisation completed; the response names the configured provider |

Both responses contain bounded status metadata and use `cache-control:
no-store`. Readiness does not perform a live object-store write or guarantee
that every provider operation will succeed. Monitor provider errors, session
creation, key grants, reads, writes, and conditional HEAD failures separately.

## Replicas and storage

Use S3, R2, or Azure Blob Storage before setting `replicaCount` above one.
Every replica must use the same object stores, master key, layouts, indexes,
and identity configuration.

Additional authority replicas can add request capacity and failure isolation.
They do not partition a collection, remove conditional HEAD contention, or
make concurrent writes to one collection cheap. Keep write bursts bounded and
use explicit mutation batches when several documents should share one
revision.

The chart does not create an HPA because useful thresholds depend on the
gateway, object-store latency, read/write mix, and collection contention.
Add autoscaling only after measuring those signals.

The `local` provider is limited to one replica and requires
`localStorage.enabled=true`. It uses an ephemeral `emptyDir` and exists only
for chart tests and local development. It is not a durable Kubernetes storage
mode, even if the cluster itself is durable.

## Upgrade and rollback

Before an upgrade:

1. Read `CHANGELOG.md` and [Versioning and compatibility](VERSIONING.md).
2. Complete any required metadata, index, layout, or key migration.
3. Keep the chart version and image version aligned.
4. Back up the object stores and deployment master key.
5. Record the current Helm revision and image digest.

Upgrade with another exact chart version. If the release is compatible and no
forward-only maintenance operation has run, use `helm rollback` to return to a
previous revision. Object storage remains the source of truth, so a Pod
rollback does not undo published collection revisions.

## Verify release signatures

The release workflow signs the image manifest and chart manifest by immutable
digest through GitHub Actions OIDC. It also publishes image provenance and an
SBOM.

Use the release-specific workflow identity when verifying either artifact:

```text
https://github.com/Jason-Doyle/thimble/.github/workflows/publish.yml@refs/tags/v3.3.0
```

Example image verification:

```powershell
docker buildx imagetools inspect ghcr.io/jason-doyle/thimbledb:3.3.0

cosign verify `
  --certificate-identity "https://github.com/Jason-Doyle/thimble/.github/workflows/publish.yml@refs/tags/v3.3.0" `
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" `
  ghcr.io/jason-doyle/thimbledb@sha256:<manifest-digest>
```

`helm pull` prints the immutable chart digest:

```powershell
helm pull oci://ghcr.io/jason-doyle/charts/thimbledb --version 3.3.0

cosign verify `
  --certificate-identity "https://github.com/Jason-Doyle/thimble/.github/workflows/publish.yml@refs/tags/v3.3.0" `
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" `
  ghcr.io/jason-doyle/charts/thimbledb@sha256:<manifest-digest>
```

## GHCR visibility

After the first publication, verify that the image and chart can be pulled
without registry credentials. The 3.3.0 packages inherited public access and
required no manual change. If repository or package settings leave a future
package private, change its visibility in GitHub package settings.

## CI smoke coverage

Required CI builds the same authority image, creates a `kind` cluster, installs
the chart with the local ephemeral provider, and verifies:

- Deployment readiness
- `/healthz` and `/readyz`
- OIDC token exchange and session creation
- configuration and capability discovery
- one authenticated document write
- one two-document mutation batch
- one read-bundle result

This proves chart wiring and authority behaviour in Kubernetes. It does not
prove production object-store durability or regional performance. Use the
provider deployment and benchmark guidance for those decisions.

See [In-app and separate authority deployment](AUTHORITY-DEPLOYMENT.md) for
the topology decision and [Operations](OPERATIONS.md) for keys, backups,
monitoring, maintenance, and incidents.
