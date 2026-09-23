# System diagrams

These diagrams use Mermaid and render directly in GitHub.

## Trust boundaries

```mermaid
flowchart LR
  subgraph Browser["Browser trust boundary"]
    UI["Application UI"]
    Client["ThimbleDB client"]
    Memory["Decoded memory LRU"]
    IDB["Device-key-encrypted IndexedDB"]
    ScopeKey["Non-extractable scope CryptoKey"]

    UI --> Client
    Client --> Memory
    Client --> IDB
    Client --> ScopeKey
  end

  subgraph BrokeredRead["Brokered private-read boundary"]
    CDN["Authenticated object endpoint"]
    Objects["TDB1 gzip + AES-GCM envelopes"]
    CDN --> Objects
  end

  subgraph Authority["Authenticated authority boundary"]
    Auth["Local Argon2id or external OIDC authentication"]
    Authorise["Scope authorisation"]
    KeyGrant["Short-lived key grant"]
    Validate["Mutation validation"]
    Commit["Conditional HEAD commit"]
    AuthStore["Private auth store<br/>users + hashes + sessions"]

    Auth --> AuthStore
    Auth --> Authorise
    Authorise --> KeyGrant
    Authorise --> Validate
    Validate --> Commit
  end

  subgraph Secrets["Platform secret boundary"]
    Master["Deployment master key"]
    Session["Session signing secret"]
    WriteCreds["Provider write credential or binding"]
  end

  Client -- "Read ciphertext with session" --> CDN
  CDN --> Authorise
  Client -- "Mutation" --> Auth
  KeyGrant -- "Raw key once, imported immediately" --> ScopeKey
  Commit -- "Encrypted writes" --> Objects
  Master --> KeyGrant
  Master --> Commit
  Session --> Auth
  WriteCreds --> Commit
```

Reads require both a current session grant and the relevant scope key.

## Read sequence

```mermaid
sequenceDiagram
  participant App as Web application
  participant Client as ThimbleDB client
  participant Memory as Memory LRU
  participant IDB as Encrypted IndexedDB
  participant Store as Object storage

  App->>Client: get(collection, id)
  Client->>Memory: Read HEAD

  alt HEAD in memory and within TTL
    Memory-->>Client: Cached HEAD
  else Memory miss
    Client->>IDB: Read encrypted cached HEAD
    alt IndexedDB hit within TTL
      IDB-->>Client: Decrypted cached HEAD
    else Missing or stale
      Client->>Store: GET HEAD with If-None-Match
      alt 304 Not Modified
        Store-->>Client: 304
        Client->>IDB: Refresh checkedAt
      else 200 Changed
        Store-->>Client: New encrypted HEAD
        Client->>IDB: Store under device-key encryption
      end
    end
  end

  Client->>Memory: Resolve root, branch, and leaf
  Client->>IDB: Load missing immutable pages
  Client->>Store: Fetch only pages absent from both caches
  Store-->>Client: TDB1 envelopes
  Client->>Client: AES-GCM decrypt, gunzip, parse
  Client-->>App: Document
```

## Write sequence

```mermaid
sequenceDiagram
  participant App as Web application
  participant Authority as Worker or Node authority
  participant Identity as Authentication system
  participant Store as R2 / S3 / Blob Storage
  participant Cache as Browser caches
  participant Tabs as Other browser tabs

  App->>Authority: POST mutation and session cookie
  Authority->>Identity: Resolve identity and allowed scope
  Identity-->>Authority: Authorised scope
  Authority->>Authority: Validate document
  Authority->>Store: Read HEAD and affected pages
  Authority->>Authority: Canonical JSON, gzip, AES-GCM
  Authority->>Store: Create immutable pages
  Authority->>Store: Update HEAD with If-Match

  alt ETag conflict
    Store-->>Authority: Precondition failed
    Authority->>Store: Reload and retry mutation
  else Commit
    Store-->>Authority: New HEAD ETag
    Authority-->>App: HEAD + root + branch + leaf bundle
    App->>Cache: Apply bundle immediately
    App->>Tabs: BroadcastChannel bundle
  end
```

## Key hierarchy and lifetime

```mermaid
flowchart TD
  Master["Deployment master key<br/>platform secret"]
  Pepper["Password pepper<br/>platform secret"]
  HKDF["HKDF-SHA-256"]
  ScopeData["Scope data key vN<br/>AES-256-GCM"]
  ScopeAddress["Scope address key vN<br/>HMAC-SHA-256"]
  Grant["Authorised key grant"]
  BrowserKey["Non-extractable scope CryptoKey<br/>memory only"]
  DeviceKey["Non-extractable device cache key<br/>IndexedDB CryptoKey"]
  Persistent["Encrypted IndexedDB values"]
  Objects["Encrypted object envelopes"]
  AuthStore["Encrypted auth records<br/>password hashes + opaque sessions"]

  Master --> HKDF
  HKDF --> ScopeData
  HKDF --> ScopeAddress
  ScopeData --> Objects
  ScopeAddress --> Objects
  Master --> AuthStore
  Pepper --> AuthStore
  ScopeData --> Grant
  Grant --> BrowserKey
  DeviceKey --> Persistent
  SessionRecord["Opaque revocable session<br/>private auth store"]
  SessionRecord --> Grant
```

The scope key and browser device key have different purposes. The scope key
protects provider storage. The device key protects persistent browser cache
entries.

## Access-scope boundary

```mermaid
flowchart TB
  Root["Application prefix"]

  Root --> Public["Scope: public<br/>gzip only"]
  Root --> TenantA["Scope: tenant-a<br/>key tenant-a:v3"]
  Root --> TenantB["Scope: tenant-b<br/>key tenant-b:v1"]
  Root --> User["Scope: user-42<br/>key user-42:v2"]

  Public --> PublicTree["Independent HEAD and trie"]
  TenantA --> TenantATree["Independent HEAD and trie"]
  TenantB --> TenantBTree["Independent HEAD and trie"]
  User --> UserTree["Independent HEAD and trie"]
```

Pages from different scopes are never combined. Granting one key therefore
does not expose records from another scope.

## Cloudflare reference deployment

```mermaid
flowchart LR
  Browser["Browser"]
  Access["Cloudflare Access"]
  Worker["Worker<br/>API + static assets"]
  R2Binding["R2 data binding<br/>writes and maintenance"]
  AuthBinding["Private R2 auth binding<br/>users + sessions + rate records"]
  ReadBroker["Worker object broker<br/>private encrypted reads"]
  R2["R2 bucket"]
  AuthR2["Private auth R2 bucket"]
  Secrets["Worker secrets"]

  Browser --> Access
  Access --> Worker
  Browser --> ReadBroker
  Worker --> R2Binding
  Worker --> AuthBinding
  ReadBroker --> Worker
  R2Binding --> R2
  AuthBinding --> AuthR2
  Secrets --> Worker
```

Cloudflare is the reference implementation because the Worker and R2 bindings
remove server management while keeping all reads behind scope authorisation.

## Provider boundary comparison

```mermaid
flowchart TB
  Engine["ThimbleDB engine<br/>cache + scopes + TDB1 + conditional HEAD"]
  Contract["ObjectStore abstraction<br/>get + put + delete + list + ETag conditions"]

  Engine --> Contract
  Contract --> CF["Cloudflare flagship"]
  Contract --> Local["Local development"]
  Contract --> Azure["Azure compatibility"]
  Contract --> AWS["AWS compatibility"]

  CF --> CFW["Worker authority"]
  CF --> CFR2["R2 data and auth bindings"]

  Local --> Node["Node authority"]
  Local --> Files["Single-process filesystem store"]

  Azure --> ACA["Container Apps authority"]
  Azure --> Blob["Data and auth Blob containers"]

  AWS --> Lambda["Lambda container authority"]
  AWS --> S3["Private data and auth S3 buckets"]
```

Only provider credentials, bindings, and read-authorisation mechanisms change.
The object and encryption protocol stays the same.
