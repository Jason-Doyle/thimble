# Deploy to Azure

Azure is a secondary deployment path using:

- Azure Container Apps for the Node authority and browser assets
- one Azure Blob container for encrypted application objects
- one separate private Blob container for auth records
- brokered private reads through the authority

The Bicep template is `deploy/azure/main.bicep`.

The Container App authority can share an application deployment boundary or
run independently behind Front Door or another same-origin gateway. See
[Authority deployment modes](AUTHORITY-DEPLOYMENT.md).

## Prerequisites

- Azure CLI
- Bicep support in Azure CLI
- a resource group
- a pushed OCI image built from the supplied Dockerfile

Build locally:

```powershell
docker build -t thimbledb:review .
```

Push the image to ACR or another registry that Container Apps can access.

## Stage 1: create storage and environment

The template disables the authority by default so storage can be created before
the application image and secrets are ready.

```powershell
az deployment group create `
  --resource-group <resource-group> `
  --template-file deploy\azure\main.bicep `
  --parameters appName=<name> `
               allowedOrigin=http://127.0.0.1:5173
```

Read `storageAccountName` and `deployedContainerName` from the deployment
outputs.

## Stage 2: deploy the authority

Set secrets in the current shell:

```powershell
$env:THIMBLE_MASTER_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Deploy:

```powershell
az deployment group create `
  --resource-group <resource-group> `
  --template-file deploy\azure\main.bicep `
  --parameters appName=<name> `
               allowedOrigin=https://<application-origin> `
               deployAuthority=true `
               containerImage=<registry/image:tag> `
               masterKey=$env:THIMBLE_MASTER_KEY `
               entraTenantId=<tenant-id> `
               entraAudience=<api-audience> `
               entraRequiredScope=thimble.access
```

Remove shell values afterwards:

```powershell
Remove-Item Env:THIMBLE_MASTER_KEY
```

For a non-Entra provider, set `oidcProviderId`, `oidcIssuer`, `oidcAudience`,
`oidcJwksUri`, and at least one of `oidcRequiredScope` or
`oidcRequiredRole`. `oidcAllowedTenants` is optional.

Generate the recommended Entra delegated scope and application roles with
`npx thimbledb generate-entra-roles --out entra-authorization.json`. Merge the
fragment with the existing application registration rather than replacing
unrelated entries.

## Template capability

The checked-in Bicep template exposes the core provider, OIDC, key-version,
collection-layout, and retention settings. It does not currently expose:

- `THIMBLE_COLLECTION_INDEXES`
- `THIMBLE_COLLECTIONS`
- `THIMBLE_HEAD_TTL_MS`
- `THIMBLE_STUDIO` or `THIMBLE_STUDIO_ORIGIN`
- `THIMBLE_READ_BUNDLES`

The supplied deployment therefore leaves Studio, covering indexes, and read
bundles disabled. Use a reviewed derived template or another Container Apps
configuration when those optional features are required. Setting variables
only in the deployment shell does not add them to the Container App.

For key rotation, set `keyVersion` to the current write version and
`readKeyVersions` to the comma-separated historical versions that remain
readable.

## Verify

- Container App uses HTTPS.
- The auth container is not exposed through any SAS or public endpoint.
- Browser object requests use the authenticated `/api/objects` broker.
- Eligible cold point reads use the advertised bounded read-bundle route.
- Object bodies begin with `TDB1`.
- The Container App can seed and mutate data.
- Direct browser reads cannot write or delete blobs.

## Recommended production hardening

The supplied Node adapter uses a storage connection string. Prefer Container
App managed identity and Entra authorisation over Shared Key for a long-lived
production deployment.

Store master and session secrets in Key Vault and reference them from
Container Apps. The Bicep template accepts secure parameters but does not
provision Key Vault.

The example disables source-IP rate limiting because Container Apps ingress
does not provide a peer address that this implementation independently
verifies. Per-subject limits remain active. Enable source-IP limits only after
configuring and testing a trusted proxy boundary.

## References

- [Azure Container Apps Bicep resources](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps)
- [Azure Blob Storage account types](https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview)
