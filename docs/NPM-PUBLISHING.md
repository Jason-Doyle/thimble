# Release publishing

ThimbleDB publishes the npm package, multi-architecture authority image, and
OCI Helm chart through `.github/workflows/publish.yml` after a GitHub release
is published.

npm uses OpenID Connect trusted publishing without `NPM_TOKEN`. GHCR uses the
release-scoped `GITHUB_TOKEN`. The image and chart use keyless Sigstore
signatures through GitHub Actions OIDC.

Trusted publishing requires npm CLI 11.5.1 or newer, Node.js 22.14 or newer,
and a GitHub-hosted runner. The workflow uses Node.js 24 and
`.github/workflows/publish.yml`.

## Bootstrap the package once

npm requires the package to exist before its trusted publisher can be added.
Complete one manual first publish from a clean `main` checkout:

```powershell
git switch main
git pull --ff-only
git status --short

npm login --auth-type=web
npm whoami
npm pack --dry-run
npm publish --access public
```

Do not send or commit the npm credential created by `npm login`.

## Configure the trusted publisher

Open the `thimbledb` package on npmjs.com, then open:

```text
Settings -> Trusted publishing -> Add trusted publisher -> GitHub Actions
```

Use these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `Jason-Doyle` |
| Repository | `thimble` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Allow `npm publish` |

The workflow filename is case-sensitive. Enter only `publish.yml`, not the
`.github/workflows/` path.

After one trusted publish succeeds, open:

```text
Settings -> Publishing access
```

Select **Require two-factor authentication and disallow tokens**. Remove any
unused write-capable npm automation tokens.

## Release process

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` through a
   pull request. Keep `deploy/helm/thimbledb/Chart.yaml` at the same version.
2. Merge only after the protected `verify` check passes and repository branch
   protection requirements are satisfied. A repository administrator may use
   the documented bypass when the sole maintainer cannot self-approve.
3. Create a matching tag such as `vX.Y.Z`.
4. Publish a GitHub release for that tag.
5. The release event runs `publish.yml`.
6. The workflow verifies that the tag matches the package and chart versions,
   runs type-checks and tests, builds the package, and uploads a one-day npm
   artifact.
7. A separate OIDC-enabled job downloads only that artifact and calls
   `npm publish`.
8. Buildx publishes `linux/amd64` and `linux/arm64` images to
   `ghcr.io/jason-doyle/thimbledb`, including provenance and an SBOM.
9. Cosign signs the immutable image manifest digest.
10. Helm packages and publishes
    `oci://ghcr.io/jason-doyle/charts/thimbledb`.
11. Cosign signs the immutable chart manifest digest and the workflow attaches
    the chart archive to the GitHub release.

If the exact version already exists, the workflow exits successfully without
attempting a duplicate publish. This supports the bootstrap release, which is
published manually before the trusted publisher exists.

The chart publication path also checks for an existing version before pushing
it again. Release versions are immutable. Do not intentionally replace an
existing npm package, image version tag, or chart version with different
source.

## GHCR visibility

After the first workflow run, verify that the image and chart can be pulled
without registry credentials. The 3.3.0 packages inherited public access and
required no manual change. If repository or package settings leave a future
package private, change its visibility in GitHub package settings.

No registry password or personal access token is required. The release job has
`packages: write` only for its duration.

## Security properties

- GitHub Actions receives a short-lived OIDC token.
- No long-lived npm token is stored in GitHub.
- Package dependencies and build tools run in a job without OIDC permission.
- The workflow has read-only repository content access and `id-token: write`.
- Publishing is tied to this repository and the exact `publish.yml` workflow.
- The image and chart are signed by immutable digest, not by a mutable tag.
- The image publishes Buildx provenance and an SBOM.
- Protected `main` rules require CI and review before version changes merge,
  with an administrator bypass reserved for the sole-maintainer case.

The repository is public, so npm automatically generates a signed provenance
attestation for trusted publishes. If the repository becomes private,
trusted OIDC publishing will continue to work, but npm will stop generating
provenance attestations.

## Troubleshooting

`ENEEDAUTH`:

- confirm the package trusted publisher is configured
- confirm the workflow filename is exactly `publish.yml`
- confirm `id-token: write` remains present
- confirm the job uses a GitHub-hosted runner

Tag mismatch:

- ensure tag `vX.Y.Z` matches `package.json` version `X.Y.Z`

Duplicate version:

- npm versions are immutable
- bump the patch version through a pull request and create a new release

Private GHCR package:

- confirm the package is linked to the public repository
- change its visibility in GitHub package settings when anonymous pulls fail

Signature verification failure:

- verify the immutable digest rather than a tag
- use the exact release workflow identity and
  `https://token.actions.githubusercontent.com` issuer
- confirm the package and its signature artifact are publicly readable
