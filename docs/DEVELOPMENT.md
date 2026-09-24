# Local development

ThimbleDB provides a loopback-only development path for evaluating the full
authority and browser flow without configuring an external identity provider.

## Scaffold a local web app

```powershell
npx thimbledb@latest create my-notes-app
cd my-notes-app
npm run dev
```

Open `http://127.0.0.1:5173`.

The same application is available as the
[Node starter repository](https://github.com/Jason-Doyle/thimbledb-node-starter).
For a Worker and R2 deployment, use the
[Cloudflare starter repository](https://github.com/Jason-Doyle/thimbledb-cloudflare-starter).

The generated app includes:

- local Node authority
- development identity
- encrypted user scope
- browser memory and IndexedDB caches
- typed notes collection
- equality and range indexes
- fluent queries
- deletion and restore
- Vite frontend

Run:

```powershell
npm run doctor
npm run build
```

## Development identity safeguards

`THIMBLE_DEV_IDENTITY=true` is accepted only when:

- `NODE_ENV` is not `production`
- `THIMBLE_PROVIDER=local`
- `THIMBLE_HOST` is `127.0.0.1`, `localhost`, or `::1`
- `THIMBLE_ALLOWED_ORIGIN` uses a loopback hostname

The authority fails startup when any condition is violated.

The development session endpoint is:

```text
POST /api/auth/dev/session
```

It still uses an HttpOnly session, CSRF token, encrypted scope, and normal
authority permissions. It does not simulate a production identity provider.

Cloudflare authority deployments do not include the development identity.

## Connect the browser

After a session exists:

```ts
import { createThimbleClient } from "thimbledb";

const db = await createThimbleClient();
```

The factory:

- loads `/api/config`
- requests encrypted scope keys
- imports non-extractable AES keys
- configures object readers
- creates memory and encrypted IndexedDB caches
- handles layout generation
- clears cache state on logout

Advanced applications can still construct each component directly.

## Move to production identity

Before deployment:

1. Remove `THIMBLE_DEV_IDENTITY`.
2. Configure Microsoft Entra or another OIDC provider.
3. Set a production allowed origin.
4. Bind only to the intended authority interface.
5. Store the master key and provider credentials in the platform secret store.
6. Run authentication, logout, scope, and deletion tests.

The authority refuses to start with the development identity in production.
