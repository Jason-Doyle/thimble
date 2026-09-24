# ThimbleDB and Firestore

Firestore is a managed document database with client SDKs, queries,
transactions, real-time listeners, and offline persistence. ThimbleDB is an
application-owned object-storage protocol with brokered reads and connected
writes.

## Choose Firestore when

- Real-time listeners are central to the user experience.
- Client SDKs should queue and synchronise offline writes.
- Document queries, filters, and managed indexes are required.
- Transactions or batched writes span multiple documents.
- A Google-managed database and security rule model are acceptable.

Firestore web persistence is optional and uses a local cache. Its
documentation warns that cached data is not automatically cleared between
sessions, which matters for sensitive applications.

## Choose ThimbleDB when

- Object storage should remain the durable backend.
- The application wants encrypted cache entries under its own device key.
- Writes must pass through an application-owned authority.
- User and tenant scope separation should influence stored object paths.
- Queries fit declared indexes or bounded collection scans.
- The app does not need offline writes or real-time subscriptions.

## Capability comparison

| Capability | ThimbleDB | Firestore |
| --- | --- | --- |
| Service model | Self-hosted authority and caller-owned storage | Managed database service |
| Query model | ID reads, declared indexes, and bounded scans | Indexed document queries |
| Real-time listeners | No | Yes |
| Offline reads | Previously cached encrypted objects | Cached documents and queries |
| Offline writes | No | Client changes synchronise when online |
| Transactions | Conditional collection updates | Multi-document transactions and batched writes |
| Browser persistence | Separate non-extractable device key | Firestore-managed local cache |
| Provider portability | R2, S3, Azure Blob, local files | Google Cloud and Firebase |
| Identity | External OIDC through authority | Firebase Auth or application-defined integration |

## Security model difference

Firestore commonly authorises client SDK operations through security rules.
ThimbleDB keeps private object storage behind an authenticated authority and
does not give storage credentials to the browser.

## Sources

- [Firestore offline data](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
- [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [ThimbleDB security](../SECURITY.md)
- [ThimbleDB authentication](../AUTHENTICATION.md)
