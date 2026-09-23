# Security model

This document states what ThimbleDB protects, what it does not protect, and
which parts remain demonstration code.

See [System diagrams](DIAGRAMS.md#trust-boundaries) for the browser, public
read, authority, and platform-secret boundaries.

## Assets

ThimbleDB protects:

- private document contents stored in object storage
- private document contents persisted in browser IndexedDB
- write credentials for R2, S3, or Blob Storage
- integrity of encrypted envelopes
- separation between configured access scopes

It does not hide:

- approximate object sizes
- request timing and frequency
- predictable scope names unless the deployment makes them opaque
- ciphertext availability where a public encrypted read path is used

## Key hierarchy

```text
Deployment master key
  HKDF-SHA-256
    scope encryption key, version N
    scope content-address HMAC key, version N

Browser device cache key
  generated locally
  non-extractable
  stored as CryptoKey in IndexedDB
```

The deployment master key belongs in a platform secret store. It is never sent
to a browser.

The authority derives a versioned scope key after authenticating and
authorising a session. The browser imports the 32-byte key as a
non-extractable AES-GCM CryptoKey and clears the temporary byte buffer. The key
is not written to cookies, localStorage, or IndexedDB.

The session cookie contains only a user ID and a 256-bit random opaque token.
Only its SHA-256 digest is stored in the private auth store. Cookies use
HttpOnly and SameSite, plus Secure outside local development.

## Envelope encryption

Private objects use AES-256-GCM with:

- a fresh random 96-bit IV for every encoded object
- a 128-bit authentication tag
- the binary envelope header as additional authenticated data
- a versioned key identifier in the authenticated header

The operation order is:

```text
canonical JSON
  gzip if it saves space
  AES-256-GCM
  binary envelope
```

Encryption before compression would remove useful redundancy and produce no
meaningful compression.

## Browser cache protection

Decoded values exist in memory while the application uses them. Persistent
cache entries are encrypted with a separate non-extractable browser-generated
AES-GCM key before they enter IndexedDB.

This protects cached values from casual disk inspection and avoids storing raw
scope keys. It does not make an origin safe after an XSS compromise. Malicious
JavaScript running in the application origin can ask Web Crypto to decrypt
data even when key bytes are non-extractable.

Required controls for a production application include:

- a strict Content Security Policy
- no unsafe inline scripts
- dependency pinning and review
- output encoding and input sanitisation
- Trusted Types where supported
- short key-grant lifetimes
- cache clearing on logout or scope loss

Clearing cached objects does not rotate the shared browser device key because
other tabs may still be writing with it. Logout flows should coordinate across
tabs, close active clients, clear cache entries, then rotate or delete the
device key in one controlled operation.

## Authentication and authorisation

Encryption keys follow authorisation scopes. A user receives only keys for
scopes the authority allows.

Local accounts use Argon2id and an authority-only encrypted auth store.
External identities use a validated OIDC access token. Both create opaque,
revocable sessions whose server-side records contain current scope grants.

See [Authentication and identity](AUTHENTICATION.md).

## Revocation

Revocation has a hard boundary:

- the authority can stop issuing a key immediately
- the authenticated read broker blocks future object retrieval after logout
- new content can move to a rotated key version
- cached encrypted content becomes inaccessible after the in-memory key is
  gone
- plaintext already displayed, copied, or retained by an authorised user
  cannot be revoked

High-risk scope removal should rotate the scope key and rewrite current live
objects. Historical encrypted objects should be removed by lifecycle or
garbage-collection policy.

## Public direct storage

Private local-auth scopes use the authenticated object broker. Public scopes
can expose R2 objects through a custom domain because no private key is
required. A deliberately non-revocable encrypted direct-read scope remains
possible, but it must not be used where logout or account disablement must stop
future reads.

This does not prevent request abuse. Use Cloudflare rate limiting, cache rules,
WAF controls, and object lifecycle policies to control cost and traffic.

## Secret handling

Never commit:

- `THIMBLE_MASTER_KEY`
- `THIMBLE_PASSWORD_PEPPER`
- Azure connection strings or SAS tokens
- AWS credentials
- R2 access keys

The repository ignores `.env`, local data, benchmark output, and tool state.
Infrastructure templates accept secrets as secure deployment parameters or
platform secret commands rather than source values.

## References

- [NIST SP 800-38D: AES-GCM and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- [MDN Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [MDN CryptoKey extractable property](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey/extractable)
- [OWASP HttpOnly](https://owasp.org/www-community/HttpOnly)
