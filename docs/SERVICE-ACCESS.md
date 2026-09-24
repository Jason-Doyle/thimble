# Machine and service access

ThimbleDB can authenticate a non-human workload through the same external
OIDC boundary used for users. A static database-wide admin key is not required
for providers that support OAuth client credentials or workload identity.

## Human live viewer

A human administrator should sign in through the normal reviewed OIDC flow.
Assign `thimble.admin` to use the identity-administration API.

`thimble.admin` is not a database-wide data bypass. It does not automatically
grant read or write access to every user or tenant scope.

For a live data viewer, grant only the tenant memberships and tenant roles the
viewer requires:

- tenant membership grants `read`
- `thimble.tenant.writer` grants `write`
- `thimble.tenant.admin` grants `write` and `admin`

The viewer then uses the normal brokered object and document endpoints. It
does not receive object-storage credentials or server encryption keys.

## Headless service principal

Microsoft Entra service principals can obtain an application token through
the client-credentials flow. Assign a ThimbleDB application role to the
service principal, then exchange the access token:

```text
POST /api/auth/oidc/entra/session
Authorization: Bearer <short-lived-access-token>
Content-Type: application/json

{}
```

The authority validates the token and creates the same opaque, revocable
session used by browser clients. A server-side caller must retain the session
cookie, read `/api/config` for its CSRF token and selected scope, and include
those values on mutations.

Do not place a client secret or service-principal access token in browser
code. A browser-based viewer should use an interactive user login.

## Generate the Entra roles

Generate a manifest fragment once:

```powershell
npx thimbledb generate-entra-roles `
  --out ".\entra-authorization.json"
```

The file contains:

- delegated scope `thimble.access`
- application role `thimble.user`
- application role `thimble.admin`
- application role `thimble.tenant.writer`
- application role `thimble.tenant.admin`

Each application role allows assignment to users or service principals.
Assign `thimble.user` alongside any elevated role when the authority uses
`ENTRA_REQUIRED_ROLE=thimble.user` as its admission requirement.

Merge the generated `appRoles` and `api.oauth2PermissionScopes` entries into
the existing Entra application registration. Do not replace unrelated roles
or scopes. Keep the generated IDs stable because Entra assignments reference
those IDs.

When application tokens must be accepted, configure a required application
role such as:

```text
ENTRA_REQUIRED_ROLE=thimble.user
```

Entra application tokens normally contain a `roles` claim rather than an
`scp` claim. Configuring both `ENTRA_REQUIRED_SCOPE` and
`ENTRA_REQUIRED_ROLE` requires both claims, so use the role-only requirement
for one authority that must accept client-credentials tokens.

## Generic OIDC providers

Create equivalent role values in the provider and include them in the
validated `roles` claim. Configure `OIDC_REQUIRED_ROLE` when machine tokens do
not contain delegated scopes.

## Why there is no global admin key

A long-lived global bearer key would:

- bypass external MFA and workload-identity controls
- have no natural tenant boundary
- be difficult to rotate without interrupting every integration
- create broad exposure if copied into a browser or log
- make per-service audit and revocation difficult

An optional built-in service-token feature would need named tokens, hashed
storage, explicit scopes and permissions, expiry, last-used audit data,
rotation, and immediate revocation. Until those controls exist, use
short-lived OIDC service identities rather than a static master credential.
