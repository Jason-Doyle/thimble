# ThimbleDB and lowdb

lowdb is a small type-safe local JSON database for JavaScript. Its standard
adapters keep a JavaScript object in memory and write JSON to a file,
localStorage, or sessionStorage. ThimbleDB is a distributed browser and
authority protocol backed by object storage.

## Choose lowdb when

- One Node process owns a small JSON file.
- A CLI, script, test harness, Electron app, or local tool needs persistence.
- Plain JavaScript array operations are enough for queries.
- The full dataset comfortably fits in memory.
- Cloud identity, tenant scopes, and multi-machine access are unnecessary.

The lowdb documentation notes that Node cluster is unsupported and whole
objects around 10-100 MB can encounter performance issues because writes
serialise the complete data object.

## Choose ThimbleDB when

- Browsers and a remote authority share a storage protocol.
- Object storage is the durable backend.
- Data needs user or tenant scope separation.
- Browser persistence should be encrypted separately from durable objects.
- Conditional writes and stale client detection are required.
- External identity and revocable sessions are part of the application.

## Capability comparison

| Capability | ThimbleDB | lowdb |
| --- | --- | --- |
| Durable storage | Object storage | JSON file, localStorage, or custom adapter |
| Process model | Browser plus authority | Usually one local process or browser context |
| Write model | Conditional immutable pages and mutable heads | Serialise and write the data object |
| Query model | ID reads and bounded scans | Native JavaScript operations |
| Browser cache | Encrypted memory and IndexedDB | localStorage or sessionStorage adapters |
| Identity and scopes | Included external OIDC model | Application-defined |
| Multi-machine use | Through authority and object store | Requires a custom remote adapter and coordination |
| Best fit | Small hosted web apps | Local scripts and tools |

## Sources

- [lowdb README](https://github.com/typicode/lowdb)
- [ThimbleDB storage providers](../STORAGE-PROVIDERS.md)
- [ThimbleDB protocol](../PROTOCOL.md)
