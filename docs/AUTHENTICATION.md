# Authentication and identity

ThimbleDB supports local accounts and external OIDC identities through one
internal user model. Identity proves who made a request. Scope authorisation
decides which encrypted trees that user can read or mutate.

## Internal user model

```ts
interface AuthUser {
  id: string
  status: "active" | "disabled"
  authVersion: number
  identities: Identity[]
  tenants: string[]
  roles: string[]
}
```

Identity records can be local, Microsoft Entra, or another OIDC issuer. One
internal user can eventually link several identities. Automatic linking by
email is not allowed.

## Authority-only auth store

Credential and session records use a separate provider binding:

```text
Data store exposed through brokered reads
  scopes/user:<id>/...
  scopes/tenant:<id>/...

Private auth store, never browser-readable
  auth-v1/identities/<keyed-hash>
  auth-v1/users/<uuid>
  auth-v1/sessions/<user-id>/<token-digest>
```

The auth store has its own private R2 bucket, S3 bucket, Azure container, or
local directory. It is encrypted with the `system-auth` key derived from the
deployment master key. No auth-store key is granted to browsers.

## Local accounts

The Node authority supports local accounts. Registration is disabled by
default in cloud deployments and enabled in local development.

Passwords use:

- Argon2id
- 19 MiB memory
- 2 iterations
- parallelism 1
- one random 16-byte salt per password
- a deployment pepper stored separately from auth records
- encoded, versioned Argon2 parameters

Passwords are never encrypted or recoverable.

Unknown accounts perform a dummy Argon2id verification. Login responses use
the same error code for missing accounts, wrong passwords, disabled accounts,
and unavailable external identities.

Password work has a separate provider-backed global limit in addition to
source-IP and account limits. This protects the Argon2 path when a deployment
cannot verify a proxy source address.

The Cloudflare Worker build deliberately disables local password endpoints.
The current Argon2 dependency requires runtime WebAssembly compilation, which
Workers does not permit. Cloudflare deployments use Entra or another OIDC
identity. Deploy the Node authority when local accounts are required. Do not
reduce Argon2 parameters or substitute a weak browser-compatible hash.

## Sessions

The browser cookie contains:

```text
<user-id>.<256-bit-random-token>
```

The server stores only the token digest in the private auth store. Session
records contain:

- user ID
- account `authVersion`
- expiry
- CSRF token
- scope grants captured when the session is issued

Cookies use HttpOnly, SameSite=Strict, and Secure outside local development.
Logout deletes the server session. Password reset and account disabling can
revoke every session below the user's session prefix.

## CSRF and browser-origin controls

Every state-changing request requires:

- exact configured `Origin`
- `Content-Type: application/json`
- a per-session `X-Thimble-CSRF` token after login
- an authorised `X-Thimble-Scope` where a write scope is selectable

CORS is not a CSRF defence.

## Private read broker

Authenticated private scopes use:

```text
/api/objects/scopes/<scope>/...
```

The authority verifies the session and read grant before returning encrypted
bytes. The browser still decrypts locally and uses the same memory and
IndexedDB caches.

Brokered reads mean a saved scope key is not enough to discover or download
future objects after session revocation. Already downloaded plaintext and
ciphertext cannot be revoked.

The supported path brokers all scopes. Direct provider URLs are not part of
the supported authentication boundary.

## Microsoft Entra

The Entra adapter validates JWT signature, issuer, audience, expiry, and
tenant. It maps identities with:

```text
tenant = tid
subject = oid
```

Email, name, and `preferred_username` are display values only. Microsoft
documents them as mutable and unsuitable for durable identity or
authorisation.

The current API exchanges an access token already obtained by the application:

```text
POST /api/auth/oidc/entra/session
Content-Type: application/json
Authorization: Bearer <token-for-the-ThimbleDB-API>
```

The application should use Microsoft Authentication Library or another
reviewed OIDC client for authorisation code flow with PKCE, state, and nonce.
ThimbleDB validates the resulting API token and creates its own revocable
session.

An Entra adapter must configure at least one required delegated scope or
application role. Automatic internal-user provisioning is disabled by default.
Set `ENTRA_AUTO_PROVISION=true` only when every principal satisfying the tenant
and claim rules should receive a ThimbleDB account.

## Current API

The Node authority exposes the local-account routes. The Cloudflare Worker
advertises `local.enabled: false` and returns 404 for those routes.

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /api/auth/config` | Public | Enabled auth providers |
| `POST /api/auth/register` | Public, rate limited, exact Origin | Optional local registration |
| `POST /api/auth/login` | Public, rate limited, exact Origin | Local login |
| `POST /api/auth/oidc/:provider/session` | Bearer token, rate limited, exact Origin | External identity exchange |
| `POST /api/auth/logout` | Session + CSRF | Revoke current session |
| `POST /api/auth/password` | Session + CSRF | Change password and revoke every session |
| `GET /api/config` | Session | User, scope, CSRF, cache config |
| `GET /api/keys/:scope` | Session + read grant | Scope key grant |

## Not implemented yet

- forgotten-password reset and email delivery
- email verification
- passkeys and MFA
- identity linking UI
- administrative account disablement
- automated scope-key rotation after account compromise
- OIDC login initiation and callback UI

These features must follow the same authority-only storage and session
revocation model.

## References

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Microsoft Entra ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Microsoft Entra OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
