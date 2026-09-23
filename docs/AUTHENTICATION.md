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

Local registration is disabled by default in cloud deployments and enabled in
local development.

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

The Worker requires a distributed `AUTH_RATE_LIMITER` binding when local auth
is enabled. In-memory limiting is available only as an explicit local
development override.

Strong Argon2id does not fit the Cloudflare Workers free-plan CPU allowance.
Local password authentication should therefore use Workers Paid or an isolated
private password-hashing service. Do not reduce Argon2 parameters to fit the
free plan.

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
- current scope grants

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

Public scopes can use direct R2, S3, or Blob URLs because no private key is
required.

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
Authorization: Bearer <token-for-the-ThimbleDB-API>
```

The application should use Microsoft Authentication Library or another
reviewed OIDC client for authorisation code flow with PKCE, state, and nonce.
ThimbleDB validates the resulting API token and creates its own revocable
session.

## Current API

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /api/auth/config` | Public | Enabled auth providers |
| `POST /api/auth/register` | Public, rate limited, exact Origin | Optional local registration |
| `POST /api/auth/login` | Public, rate limited, exact Origin | Local login |
| `POST /api/auth/oidc/:provider/session` | Bearer token, rate limited, exact Origin | External identity exchange |
| `POST /api/auth/logout` | Session + CSRF | Revoke current session |
| `GET /api/config` | Session | User, scope, CSRF, cache config |
| `GET /api/keys/:scope` | Session + read grant | Scope key grant |

## Not implemented yet

- password reset and email delivery
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
