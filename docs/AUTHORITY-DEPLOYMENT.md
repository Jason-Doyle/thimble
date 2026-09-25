# Authority deployment modes

ThimbleDB separates the browser client from the authenticated authority. The
authority can run in the application's deployment or as a separately operated
Worker, container, or function.

This is a process and deployment choice. In both modes, expose application and
authority routes through one public browser origin unless an independently
reviewed cross-origin session design replaces the default Strict cookie
contract.

## Decision summary

| Consideration | Embedded authority | Separate authority service |
| --- | --- | --- |
| Deployment units | One application deployment | Application plus authority deployment |
| Browser origin | Naturally the same | Use a gateway or path route to preserve one public origin |
| Secrets | Application runtime also holds authority and storage secrets | Storage credentials and master key remain outside the application runtime |
| Release cadence | Application and authority change together | Authority can be upgraded independently |
| Scaling | Application and authority scale together | Reads, writes, and application rendering can scale separately |
| Failure boundary | One runtime can affect both application and data API | Application and authority failures are isolated |
| Operations | Simplest setup and observability | More routing, monitoring, version coordination, and incident paths |
| Latency | No service-to-service hop inside the deployment | Gateway and service routing may add latency |
| Best fit | One small application and one operations team | Shared platform boundary, stricter secret isolation, or independently scaled authority |

The storage provider does not determine the topology. A Node authority can use
local files, Azure Blob Storage, S3, or R2 in either deployment model. A
Cloudflare authority can share one Worker deployment with application assets
or run as a dedicated routed Worker.

## Embedded authority

The authority starts as part of the application deployment. The application
and data API normally share one release, hostname, logs, and scaling policy.

Cloudflare example:

```ts
import {
  createCloudflareAuthority,
} from "thimbledb/authority/cloudflare";
import {
  collectionIndexes,
  collectionLayouts,
} from "./collections";

export default createCloudflareAuthority({
  studio: true,
  readBundles: true,
  collections: ["notes"],
  collectionIndexes,
  collectionLayouts,
});
```

The same Worker can serve static assets through an `ASSETS` binding and run
the authority for `/api/*`.

Node example:

```ts
import {
  startNodeAuthority,
} from "thimbledb/authority/node";

await startNodeAuthority({
  studio: true,
  readBundles: true,
  collections: ["notes"],
  collectionIndexes,
  collectionLayouts,
});
```

The application deployment owns the authority process. A gateway can expose
the application frontend and authority listener through one public origin.

Choose this mode when:

- one application owns the data model
- one deployment lifecycle is acceptable
- the smallest operational surface is more important than secret isolation
- application and authority traffic have similar scaling needs
- a same-origin browser path should require no additional routing layer

Avoid it when a compromise of the application runtime must not expose the
storage credential or deployment master key.

## Separate authority service

The authority runs in its own Worker, container, Lambda function, Container
App, or Node service. The browser application remains a normal ThimbleDB
client.

Typical public routing:

```text
https://app.example.com/           -> application assets or application server
https://app.example.com/api/*      -> separate ThimbleDB authority
https://app.example.com/studio/*   -> authority or version-matched Studio assets
```

The authority service owns:

- OIDC token exchange and opaque sessions
- CSRF and exact Origin enforcement
- scope grants and key grants
- read bundles and encrypted-object broker routes
- validation, writes, retained deletion, and maintenance
- storage credentials and the deployment master key

The application runtime needs none of those storage secrets.

Choose this mode when:

- application and authority releases need independent approval or rollback
- storage credentials require a smaller runtime trust boundary
- several application processes use one authority contract
- write and broker traffic need independent scaling or observability
- platform routing already supports path-based service isolation

The additional cost is real: another deployment, route, health check, log
stream, alert set, version boundary, and incident path must be operated.

## Same-origin browser boundary

The default ThimbleDB session cookie is `HttpOnly` and `SameSite=Strict`.
Browser caches, BroadcastChannel logout, localStorage cache registries, and
IndexedDB are origin-scoped. For that reason, a separate process should not
automatically imply a separate browser hostname.

`THIMBLE_ALLOWED_ORIGIN` validates state-changing requests. It does not by
itself turn the default browser client into a cross-origin cookie system.

Prefer a reverse proxy, Worker route, Function URL gateway, Front Door route,
or application gateway that preserves one public origin. Review all of the
following before intentionally introducing a separate authority origin:

- cookie `SameSite`, `Secure`, and domain attributes
- credentialed CORS responses and preflight behaviour
- CSRF and exact Origin validation
- cache namespace and logout coordination across origins
- Studio hosting and session behaviour
- redirect and callback URLs at the OIDC provider

## Performance implications

Read bundles work in both deployment modes because the browser discovers the
optional endpoint from `/api/config`.

Enable them explicitly with `readBundles: true` or
`THIMBLE_READ_BUNDLES=true`. Existing deployments retain the individual TDB1
object path until that capability is enabled.

The trusted authority assembles bundle cache values after decrypting storage
objects and sends them over HTTPS with `no-store`. Leave the capability
disabled if the deployment requires every read response above TLS to remain a
TDB1 envelope.

An embedded authority removes one internal routing boundary. A separate
authority can instead be placed near object storage and scaled independently.
Neither choice changes the number of browser requests once the same public
route reaches the authority.

Measure:

- browser-to-authority latency
- authority-to-object-storage latency
- cold read-bundle duration and fallback count
- session and key-grant duration
- conditional-write conflicts
- application and authority CPU independently

Do not claim one topology is faster without testing the actual gateway,
runtime, and storage region.

## Security implications

Both modes enforce the same sessions, scope grants, encryption, deletion, and
conditional-write rules.

Embedded mode has a larger runtime blast radius because application server
code and authority secrets coexist. Separate mode narrows that secret boundary
but adds routing and service-to-service configuration that can itself be
misconfigured.

In either mode:

- keep object storage private
- expose reads only through the authenticated broker or bounded bundle route
- keep provider credentials and the master key out of browser code
- use exact allowed origins
- keep application and authority package versions compatible
- use logical exports and provider backups independently of deployment shape

## Recommendation

Start embedded for one small application unless a concrete security,
operations, or scaling requirement justifies a separate authority. Move the
authority into a separate service without changing application collection
code, storage layout, or browser query semantics.
