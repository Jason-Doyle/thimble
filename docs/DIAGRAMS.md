# System diagrams

These Mermaid diagrams describe the ThimbleDB 2.1 data, identity, query,
index, migration, and deployment paths.

## Trust boundaries

```mermaid
flowchart LR
  subgraph Browser["Browser trust boundary"]
    UI["Application UI"]
    Client["ThimbleDB client"]
    Memory["Scope-namespaced memory cache"]
    IDB["Scope-namespaced, device-key-encrypted IndexedDB"]
    ReadKeys["Non-extractable decrypt-only scope keys"]

    UI --> Client
    Client --> Memory
    Client --> IDB
    Client --> ReadKeys
  end

  subgraph Authority["Application authority boundary"]
    Exchange["OIDC token exchange"]
    Session["Opaque revocable session"]
    Authorizer["Current scope-grant calculation"]
    Broker["Authenticated encrypted-object broker"]
    Mutation["Mutation validation and execution"]

    Exchange --> Session
    Session --> Authorizer
    Authorizer --> Broker
    Authorizer --> Mutation
  end

  subgraph DataStore["Private data object storage"]
    Heads["Mutable collection HEAD records"]
    Pages["Immutable encrypted document and index pages"]
  end

  subgraph AuthStore["Separate private authentication storage"]
    Identities["Identity mappings and users"]
    Sessions["Session digests and CSRF state"]
    Limits["Authentication rate-limit state"]
  end

  subgraph Platform["Platform secret boundary"]
    Master["Deployment master key"]
    Provider["Storage credential or platform binding"]
  end

  UI -- "Session cookie + CSRF + requested scope" --> Authority
  Client -- "Brokered ciphertext reads" --> Broker
  Broker --> Heads
  Broker --> Pages
  Mutation -- "Create immutable objects" --> Pages
  Mutation -- "Conditional HEAD publication" --> Heads
  Exchange --> Identities
  Session --> Sessions
  Exchange --> Limits
  Master --> Mutation
  Master --> ReadKeys
  Master --> AuthStore
  Provider --> Broker
  Provider --> Mutation
```

The browser receives decrypt-only scope keys. It never receives a storage
credential, an authority write key, or a database-wide administrator key.

## Connection and key-grant sequence

```mermaid
sequenceDiagram
  participant App as Application
  participant Client as createThimbleClient
  participant Authority as Authority
  participant Auth as Private auth store
  participant Cache as Browser caches

  App->>Client: Create connection
  Client->>Authority: GET /api/config with session cookie
  Authority->>Auth: Reload current user and session
  Authority->>Authority: Recalculate current grants
  Authority-->>Client: Scope, CSRF, layouts, indexes, generation, active key ID

  alt Encrypted scope
    Client->>Authority: GET scope key grant
    Authority->>Authority: Require current read grant
    Authority-->>Client: Current and readable historical scope keys
    Client->>Client: Import non-extractable decrypt-only CryptoKeys
  end

  Client->>Cache: Create authority-and-scope namespace
  Client-->>App: Ready typed client
```

Custom cache implementations receive the same authority-and-scope namespace
as the built-in caches. Reusing one cache object cannot expose another scope.

## Point read and bounded query planning

```mermaid
flowchart TD
  Query["Typed query expression"]
  Validate["Validate version, values, limits, depth, and scan bound"]
  Point{"ID equality?"}
  Index{"Matching declared index with indexable values?"}
  Head["Read collection HEAD"]
  IndexPage["Read immutable encrypted index page"]
  Candidates["Resolve bounded candidate IDs"]
  ReadDocs["Read candidate documents<br/>coalesce shared immutable reads"]
  Predicate["Re-evaluate complete predicate"]
  Scan["Read bounded collection"]
  Order["Apply deterministic ordering and limit"]
  Result["Return documents and plan metadata"]

  Query --> Validate --> Point
  Point -- Yes --> ReadDocs
  Point -- No --> Index
  Index -- Yes --> Head --> IndexPage --> Candidates --> ReadDocs
  Index -- No --> Scan
  ReadDocs --> Predicate --> Order --> Result
  Scan --> Predicate
```

Arrays and objects are not secondary-index values. Queries using those values
fall back to a bounded scan instead of returning an empty indexed result.

## Indexed query read sequence

```mermaid
sequenceDiagram
  participant App as Application
  participant Client as ThimbleDB client
  participant Cache as Scope-namespaced caches
  participant Broker as Authenticated object broker
  participant Store as Private object storage

  App->>Client: where(...).orderBy(...).take(...).get()
  Client->>Client: Validate query and choose point, index, or scan plan
  Client->>Cache: Read collection HEAD

  alt HEAD missing or stale
    Client->>Broker: GET encrypted HEAD with session
    Broker->>Store: Read object with ETag condition
    Store-->>Broker: Encrypted HEAD
    Broker-->>Client: Encrypted HEAD
    Client->>Cache: Store decrypted value under device-key encryption
  end

  alt Index plan
    Client->>Cache: Read referenced immutable index page
    Client->>Broker: Fetch index page on cache miss
    Client->>Client: Resolve candidate IDs within maxScan
  else Scan plan
    Client->>Client: Enforce bounded collection scan
  end

  Client->>Cache: Resolve snapshot once or shared trie nodes
  Client->>Broker: Fetch only missing immutable objects
  Client->>Client: Decrypt, validate candidates, order, and limit
  Client-->>App: Documents plus point/index/scan plan
```

## Atomic document and index write

```mermaid
sequenceDiagram
  participant App as Application
  participant Authority as Worker or Node authority
  participant Auth as Auth service
  participant Store as R2, S3, Blob, or local store
  participant Cache as Current browser caches
  participant Tabs as Other browser tabs

  App->>Authority: Mutation + session + CSRF + scope + generation
  Authority->>Auth: Reload user and recalculate grants
  Auth-->>Authority: Current write grant or denial
  Authority->>Store: Read HEAD and affected immutable objects
  Authority->>Authority: Validate document and update configured indexes
  Authority->>Store: Create immutable document/root objects
  Authority->>Store: Create immutable index pages
  Authority->>Store: Publish one HEAD with all document and index references using If-Match

  alt ETag conflict
    Store-->>Authority: Precondition failed
    Authority->>Store: Reload current HEAD and retry
  else Commit
    Store-->>Authority: New HEAD ETag
    Authority-->>App: Committed object bundle
    App->>Cache: Apply new HEAD and immutable objects
    App->>Tabs: Broadcast committed bundle
  end
```

Document roots and secondary indexes become visible through the same
conditional HEAD write. A process that sees existing index references but has
no matching index configuration refuses to rewrite the collection.

## Key hierarchy, rotation, and browser lifetime

```mermaid
flowchart TD
  Master["Deployment master key<br/>platform secret"]
  HKDF["HKDF-SHA-256"]
  DataKey["Scope data key vN<br/>AES-256-GCM"]
  AddressKey["Scope address key vN<br/>HMAC-SHA-256"]
  AuthKey["System-auth key<br/>AES-256-GCM"]
  Objects["TDB1 encrypted objects"]
  Addresses["Private deterministic object addresses"]
  AuthRecords["Encrypted users, identity mappings, sessions, and limits"]
  Grant["Short-lived authorised key grant"]
  BrowserKeys["Non-extractable decrypt-only keys<br/>memory only"]
  DeviceKey["Non-extractable device cache key"]
  Persistent["Encrypted IndexedDB values"]
  ConfigCheck["Configuration check<br/>layout generation + active scope key ID"]
  Reload["Destroy scoped cache and reload client"]

  Master --> HKDF
  HKDF --> DataKey
  HKDF --> AddressKey
  HKDF --> AuthKey
  DataKey --> Objects
  AddressKey --> Addresses
  AuthKey --> AuthRecords
  DataKey --> Grant --> BrowserKeys
  DeviceKey --> Persistent
  ConfigCheck -- "Key or layout changed" --> Reload
```

A new connection receives the active key and configured readable historical
keys. An existing connection reloads when the active scope key ID changes.

## Scope-grant boundary

```mermaid
flowchart TB
  Identity["Validated user or service identity"]
  Principal["Internal principal<br/>current roles + tenant memberships"]
  Authorizer["Default scope authorizer"]

  User["user:&lt;uuid&gt;<br/>read + write"]
  TenantRead["tenant:&lt;id&gt;<br/>read"]
  TenantWrite["tenant:&lt;id&gt;<br/>read + write<br/>tenant writer or admin role"]
  TenantAdmin["tenant:&lt;id&gt;<br/>admin<br/>tenant admin role"]
  Role["role:&lt;role&gt;<br/>read"]

  Identity --> Principal --> Authorizer
  Authorizer --> User
  Authorizer --> TenantRead
  Authorizer --> TenantWrite
  Authorizer --> TenantAdmin
  Authorizer --> Role
```

`thimble.admin` authorizes identity-administration endpoints. It does not
implicitly grant access to every data scope.

## Human and service authentication

```mermaid
flowchart LR
  Human["Human administrator"]
  Service["Service principal or workload identity"]
  OIDC["External OIDC provider"]
  UserToken["Interactive access token"]
  AppToken["Short-lived application token"]
  Exchange["ThimbleDB OIDC session exchange"]
  Session["Opaque revocable session"]
  Grants["Current explicit scope grants"]
  Viewer["Live viewer or automation endpoint"]

  Human --> OIDC --> UserToken --> Exchange
  Service --> OIDC --> AppToken --> Exchange
  Exchange --> Session --> Grants --> Viewer
```

Machine access uses provider-managed application roles and short-lived OIDC
tokens. ThimbleDB does not use a static global admin key.

## Logical migration boundary

```mermaid
flowchart LR
  Source["JSON, CSV, lowdb, SQLite,<br/>PostgreSQL, Firestore, or ThimbleDB"]
  Adapter["Explicit migration adapter"]
  Archive["Plaintext logical archive<br/>manifest + deterministic NDJSON + SHA-256"]
  Validate["Checksum, shape, count,<br/>path, and tombstone validation"]
  DryRun["Archive-wide target preflight"]
  Quiescent["Quiescent write window"]
  Import["Create, replace, or merge import"]
  Verify["Read-back full-document verification"]
  Target["Encrypted ThimbleDB collections<br/>or explicit external target"]
  Backup["Separate encrypted provider backup"]

  Source --> Adapter --> Archive --> Validate --> DryRun --> Quiescent
  Quiescent --> Import --> Target --> Verify
  Backup -. "Rollback protection" .-> Quiescent
```

Logical archives are portable plaintext exports, not provider backups.
Cross-collection imports are preflighted before the first write but are not
one distributed transaction.

## Local scaffold and production transition

```mermaid
flowchart LR
  Create["npx thimbledb create"]
  Local["Loopback Node authority<br/>local provider"]
  DevIdentity["Explicit loopback-only<br/>development identity"]
  TypedApp["Vite app<br/>typed notes + declared indexes"]
  Validate["doctor + build + browser CRUD verification"]
  Production["Production authority"]
  OIDC["External OIDC"]
  CloudStore["R2, S3, Azure Blob,<br/>or controlled local storage"]

  Create --> Local
  Local --> DevIdentity
  Local --> TypedApp
  TypedApp --> Validate
  Validate --> Production
  Production --> OIDC
  Production --> CloudStore
```

The development identity is unavailable in the Cloudflare authority and the
Node authority refuses it outside local, loopback, non-production settings.

## Cloudflare reference deployment

```mermaid
flowchart LR
  Browser["Browser application"]
  OIDC["External OIDC provider"]
  Worker["Cloudflare Worker<br/>static assets + authority + object broker"]
  DataBinding["Private R2 data binding"]
  AuthBinding["Separate private R2 auth binding"]
  DataR2["Encrypted data bucket"]
  AuthR2["Encrypted identity and session bucket"]
  Secrets["Worker secrets<br/>master key and OIDC configuration"]

  Browser --> OIDC
  OIDC --> Browser
  Browser --> Worker
  Worker --> OIDC
  Worker --> DataBinding --> DataR2
  Worker --> AuthBinding --> AuthR2
  Secrets --> Worker
```

The Worker brokers private reads and performs every write. R2 credentials and
scope encryption material are not exposed to browser code.

## Provider boundary comparison

```mermaid
flowchart TB
  Protocol["ThimbleDB protocol<br/>scopes + TDB1 + layouts + indexes + conditional HEAD"]
  Contract["ObjectStore contract<br/>get + put + delete + list + ETag conditions"]

  Protocol --> Contract
  Contract --> CF["Cloudflare reference"]
  Contract --> Local["Local development"]
  Contract --> Azure["Azure deployment"]
  Contract --> AWS["AWS deployment"]

  CF --> CFW["Worker authority"]
  CF --> CFR2["Private R2 data and auth bindings"]

  Local --> Node["Node authority"]
  Local --> Files["Single-process filesystem store"]

  Azure --> ACA["Container Apps authority"]
  Azure --> Blob["Separate data and auth Blob containers"]

  AWS --> Lambda["Lambda container authority"]
  AWS --> S3["Separate private data and auth S3 buckets"]
```

Provider credentials, deployment primitives, and bindings differ. The stored
envelope, scope, query-index, deletion, and conditional-publication protocols
remain the same.
