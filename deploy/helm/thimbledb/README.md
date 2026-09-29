# ThimbleDB Helm chart

This chart deploys the ThimbleDB Node authority. It does not provision object
storage, OIDC applications, DNS, certificates, or provider credentials.

## Required inputs

- `existingSecret`: a Kubernetes Secret containing `THIMBLE_MASTER_KEY` and
  the selected provider credentials and bucket/container names
- `config.provider`: `s3`, `r2`, or `azure` for production
- `config.allowedOrigin`: the exact browser origin

Ingress is disabled by default. Preserve one browser origin by routing
`/api/*` and optionally `/studio/*` through the application's existing
Ingress or gateway.

## Install

Use Helm 3.18 or newer. Chart and application versions remain aligned.

```powershell
helm upgrade --install thimbledb `
  oci://ghcr.io/jason-doyle/charts/thimbledb `
  --version 3.3.0 `
  --namespace thimbledb `
  --create-namespace `
  --values .\thimbledb-values.yaml
```

The image defaults to `ghcr.io/jason-doyle/thimbledb:<chart appVersion>`.
Set `image.digest` to an immutable `sha256:` manifest digest when required.
The digest takes precedence over `image.tag`.

## Secrets

Create the Secret separately. Do not commit a rendered Secret or credentials.

For S3-compatible storage, the Secret normally contains:

- `THIMBLE_MASTER_KEY`
- `S3_BUCKET`
- `S3_AUTH_BUCKET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- optional `AWS_SESSION_TOKEN`

For R2, use the documented `R2_*` variables. For Azure, use
`AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER`, and
`AZURE_AUTH_STORAGE_CONTAINER`.

`values.example.yaml` contains commented configuration examples.

## Replicas and storage

The default is one replica. Additional replicas require one shared cloud
object store and do not remove per-collection HEAD contention.

The local provider requires `localStorage.enabled=true`, allows one replica,
and uses an ephemeral `emptyDir`. It exists for chart smoke tests and local
development, not production persistence.

## Security defaults

- non-root UID/GID 1000
- read-only root filesystem
- RuntimeDefault seccomp
- all Linux capabilities dropped
- no service-account token mount
- Ingress disabled
- Recreate deployment strategy
- credentials loaded only from an existing Secret

The chart creates no active cloud resources and contains no credential
placeholders.

Set `serviceAccount.automount=true` only when the selected cloud workload
identity requires a projected ServiceAccount token.

## First GHCR publication

GitHub creates new container packages as private. After the first release,
open the package settings for both the image and chart and change visibility
to public. GitHub does not currently provide an API for automating that
one-time visibility change.
