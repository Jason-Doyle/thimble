# Multi-tenant internal operations portal

Use ThimbleDB for procedures, equipment records, checklists, reference
material, and low-frequency operational updates within small organisations.

## Workload assumptions

- OIDC claims identify the tenant and application roles.
- Most content is read frequently and changed occasionally.
- Shared writes are modest and do not require real-time collaboration.
- Cross-tenant queries are unnecessary.
- Administrators can manage internal mappings and revoke sessions.

## Why it fits

Tenant scopes separate stored objects and encryption keys. Provider roles can
grant tenant read, write, or administrator access. User scopes remain
available for private drafts or preferences.

Snapshot layout works well for procedures and reference material. Trie layout
is available for larger collections with direct point reads or more frequent
writes.

## When not to use it

Choose another system for:

- high-frequency shared updates
- one transaction spanning many collections
- organisation-wide analytics
- large cross-tenant reporting
- complex row-level permission rules

## Suggested scopes and collections

| Scope | Collection | Starting layout | Notes |
| --- | --- | --- | --- |
| `tenant:<id>` | `procedures` | Snapshot | Small, scan-heavy reference data |
| `tenant:<id>` | `equipment` | Trie | Direct reads by equipment ID |
| `tenant:<id>` | `checklists` | Snapshot | Templates and instructions |
| `tenant:<id>` | `inspections` | Trie | Occasional appended records |
| `user:<uuid>` | `drafts` | Snapshot | Private working state |

Do not combine different tenants in one collection.

## Authority behaviour

- Require a tenant claim or application assignment before issuing tenant
  grants.
- Reserve `thimble.tenant.writer` and `thimble.tenant.admin` for explicit
  provider assignments.
- Use `thimble.admin` only for internal user administration and scope erasure.
- Revoke every session after disabling a user or changing application access.

## Minimal write

```ts
await tenantDb.write("equipment", "pump-17", {
  id: "pump-17",
  name: "Transfer pump 17",
  status: "available",
  updatedAt: new Date().toISOString(),
});
```

`tenantDb` must be created from a key grant for the authorised tenant scope.
Do not reuse a user-scope client for tenant data.

## Scaffold prompt

```text
Add a small multi-tenant operations portal using ThimbleDB 1.x.

Map OIDC tenant and role claims to `tenant:<id>` scopes. Store procedures and
checklist templates as snapshots, equipment and inspections as tries, and
private drafts in `user:<uuid>`. Require `thimble.tenant.writer` for tenant
writes and `thimble.tenant.admin` for tenant administration.

Do not add cross-tenant scans, shared global collections, local passwords, or
real-time collaboration. Add tests for tenant isolation, role removal, session
revocation, administrator disablement, and scope erasure.
```

## Validation checklist

- A user without a tenant claim receives no tenant key.
- Tenant A cannot request Tenant B objects or keys.
- Reader roles cannot write.
- Writer and administrator roles receive only documented permissions.
- Role removal changes grants on later authentication.
- Disabling a user invalidates existing sessions.
- Scope erasure hides all selected tenant collections.
- Retired layouts remain until the rollback window expires.
