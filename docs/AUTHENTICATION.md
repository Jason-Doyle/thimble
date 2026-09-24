# Authentication and identity

ThimbleDB delegates credential security to Microsoft Entra or another OIDC
provider. It does not store passwords, password hashes, recovery tokens,
verification state, passkeys, or MFA secrets.

The authority stores a minimal identity mapping so application content can
remain attached to one stable internal user ID:

```text
External provider
  issuer + subject
        |
        v
Private auth store
  auth-v1/identities/<keyed-hash>
  auth-v1/users/<internal-uuid>
  auth-v1/sessions/<internal-uuid>/<token-digest>
        |
        v
Data scope
  user:<internal-uuid>
```

## Stored identity records

An internal user record contains:

- generated internal UUID
- active or disabled status
- account security version
- provider, issuer, and immutable provider subject
- current tenant IDs and roles copied from validated claims
- creation and update timestamps

Email, display name, and provider username are not authorization identifiers.
The identity index is an HMAC-obscured value derived from provider, issuer,
and subject. Auth records use a separate encrypted object store that is never
browser-readable.

The first valid token for an accepted identity creates the minimal mapping.
Later token exchanges refresh tenant and role claims while retaining the same
internal UUID and therefore the same `user:<uuid>` data scope. A disabled
internal user remains denied even when the external token is otherwise valid.

Upgrades from the former local-password implementation should run:

```powershell
npm run migrate:external-auth
```

The migration revokes legacy sessions, deletes local identity indexes, removes
password material, and preserves each internal UUID. A user with no external
identity is disabled, so its content remains under the same `user:<uuid>`
scope without remaining accessible through the removed credential path.

## Token validation

Every provider must configure at least one required delegated scope or
application role. The adapter validates:

- JWT signature against the provider JWKS
- exact issuer
- exact audience
- expiry
- required scope and/or role
- configured tenant allowlist, when present

Microsoft Entra identities use:

```text
tenant = tid
subject = oid
```

Generic OIDC identities use the standard `sub` claim. The optional `tid`,
`roles`, and space-delimited `scp` claims can drive tenant and role grants.

OIDC provider outages and JWKS retrieval failures surface as server errors.
Malformed, expired, incorrectly signed, or unauthorized tokens receive the
same invalid-credentials response.

## Session exchange

The host application obtains an API access token through its reviewed OIDC
authorization-code flow with PKCE, state, and nonce. It exchanges that token
for a ThimbleDB session:

```text
POST /api/auth/oidc/<provider-id>/session
Content-Type: application/json
Authorization: Bearer <access-token>

{}
```

The access token is used only for the exchange and is not stored by
ThimbleDB. The authority creates a revocable opaque session cookie:

```text
<internal-user-id>.<256-bit-random-token>
```

Only the token digest is stored. Session records contain the internal user ID,
account security version, provider, expiry, CSRF token, and issued scope
grants. Cookies use HttpOnly, SameSite=Strict, and Secure outside local
development.

On every authenticated request the authority reloads the current internal user
record and recalculates grants. Role or tenant removal observed during a later
OIDC exchange therefore also affects existing sessions.

## Identity linking

Linking never uses email matching. A user must have:

- a current ThimbleDB session created within the last 10 minutes
- a fresh valid access token for the identity being linked
- an identity that is not already mapped to another internal user

The new identity is attached to the existing internal UUID, so every linked
provider reaches the same `user:<uuid>` content scope. Removing an identity
increments the account security version and revokes every session. The final
identity cannot be removed.

Provider claims are retained per linked identity. Application-assigned roles
and tenants are stored separately and combined with the claims for the
identity that created the current session.

## Administration

The external app role `thimble.admin` authorizes the administration API and
minimal browser panel. Administrators can:

- list internal user mappings
- activate or disable a mapping
- assign application-specific roles and tenants
- revoke every session for a user
- schedule user or tenant scope erasure
- run quiescent layout migration and retention maintenance

Administrative changes increment the account security version and revoke
existing sessions. They do not change credentials or provider-owned MFA.

## Scope grants

The default authorizer grants:

- read and write access to `user:<internal-user-id>`
- read access to each `tenant:<tenant-id>`
- tenant write access only for configured writer or admin roles
- tenant admin access only for configured admin roles
- read access to `role:<role-name>` scopes

Provider claims are inputs to authorization. Email and display claims are not.

## CSRF and browser-origin controls

Every state-changing request requires:

- exact configured `Origin`
- `Content-Type: application/json`
- a per-session `X-Thimble-CSRF` token after session exchange
- an authorized `X-Thimble-Scope` where a write scope is selectable

CORS is not a CSRF defence.

## Private read broker

Authenticated scopes use:

```text
/api/objects/scopes/<scope>/...
```

The authority verifies the session and current read grant before returning
encrypted bytes. The browser decrypts locally and retains its memory and
IndexedDB caches.

A saved scope key is not enough to download future objects after session
revocation because the object broker still requires authorization. Plaintext
or ciphertext already downloaded by an authorized user cannot be revoked.

## Provider configuration

Entra uses:

```text
ENTRA_TENANT_ID
ENTRA_AUDIENCE
ENTRA_REQUIRED_SCOPE and/or ENTRA_REQUIRED_ROLE
```

One generic OIDC provider can also be configured:

```text
OIDC_PROVIDER_ID
OIDC_ISSUER
OIDC_AUDIENCE
OIDC_JWKS_URI
OIDC_ALLOWED_TENANTS
OIDC_REQUIRED_SCOPE and/or OIDC_REQUIRED_ROLE
```

The provider ID becomes the route segment used during session exchange.

Generate the recommended Entra delegated scope and application roles:

```powershell
npx thimbledb generate-entra-roles `
  --out ".\entra-authorization.json"
```

Merge the generated entries with the existing application registration and
keep their generated IDs stable. The output is not applied automatically.

For non-human callers and live administration tools, see
[Machine and service access](SERVICE-ACCESS.md).

## HTTP API

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /api/auth/config` | Public | Configured external provider IDs |
| `POST /api/auth/oidc/:provider/session` | Bearer token, rate limited, exact Origin | Validate identity, map internal user, issue session |
| `POST /api/auth/logout` | Exact Origin; CSRF when session is valid | Revoke current session and clear cookie |
| `POST /api/auth/identities/:provider/link` | Recent session + CSRF + fresh provider token | Link another external identity |
| `POST /api/auth/identities/unlink` | Recent session + CSRF | Remove a non-final identity and revoke sessions |
| `GET /api/config` | Session | Current user, scope, CSRF, and cache config |
| `GET /api/keys/:scope` | Session + read grant | Scope key grant |
| `GET /api/admin/users` | `thimble.admin` | List identity mappings |
| `POST /api/admin/users/:id` | `thimble.admin` + CSRF | Change status, application roles, or tenants |
| `POST /api/admin/users/:id/revoke-sessions` | `thimble.admin` + CSRF | Revoke every user session |

## Deliberately delegated controls

The identity provider owns:

- password policy and password reset
- email or phone verification
- passkeys
- MFA and recovery factors
- suspicious-login detection
- credential breach response

ThimbleDB does not attempt to replace provider-side identity governance.

## Local development identity

The Node authority can enable a development-only identity:

```powershell
$env:THIMBLE_PROVIDER = "local"
$env:THIMBLE_HOST = "127.0.0.1"
$env:THIMBLE_ALLOWED_ORIGIN = "http://127.0.0.1:5173"
$env:THIMBLE_DEV_IDENTITY = "true"
```

The authority refuses this configuration when:

- `NODE_ENV=production`
- the provider is not local
- the authority host is not loopback
- the allowed browser origin is not loopback

The development route issues a normal HttpOnly session backed by an encrypted
user scope. It does not simulate production OIDC claims and is unavailable in
the Cloudflare authority.

See [Local development](DEVELOPMENT.md).

## References

- [Microsoft Entra ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Microsoft Entra OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
