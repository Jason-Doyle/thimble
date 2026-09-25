# npm trusted publishing

ThimbleDB publishes through GitHub Actions and npm OpenID Connect trusted
publishing. The workflow does not use `NPM_TOKEN`.

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
   pull request.
2. Merge only after the protected `verify` check passes and repository branch
   protection requirements are satisfied. A repository administrator may use
   the documented bypass when the sole maintainer cannot self-approve.
3. Create a matching tag such as `vX.Y.Z`.
4. Publish a GitHub release for that tag.
5. The release event runs `publish.yml`.
6. The workflow verifies that the tag matches the package version, runs
   type-checks and tests, builds the package, and uploads a one-day artifact.
7. A separate OIDC-enabled job downloads only that artifact and calls
   `npm publish`.

If the exact version already exists, the workflow exits successfully without
attempting a duplicate publish. This supports the bootstrap release, which is
published manually before the trusted publisher exists.

## Security properties

- GitHub Actions receives a short-lived OIDC token.
- No long-lived npm token is stored in GitHub.
- Package dependencies and build tools run in a job without OIDC permission.
- The workflow has read-only repository content access and `id-token: write`.
- Publishing is tied to this repository and the exact `publish.yml` workflow.
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
