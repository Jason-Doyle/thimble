# Deploy to Azure

Azure is a secondary deployment path using:

- Azure Container Apps for the Node authority and browser assets
- Azure Blob Storage for encrypted object envelopes
- a read-only container SAS for direct browser reads

The Bicep template is `deploy/azure/main.bicep`.

## Prerequisites

- Azure CLI
- Bicep support in Azure CLI
- a resource group
- a pushed OCI image containing this repository's Dockerfile output

Build locally:

```powershell
docker build -t thimbledb:review .
```

Push the image to ACR or another registry that Container Apps can access.

## Stage 1: create storage and environment

The template disables the authority by default so the storage account can be
created before its read-only SAS URL exists.

```powershell
az deployment group create `
  --resource-group <resource-group> `
  --template-file deploy\azure\main.bicep `
  --parameters appName=<name> `
               allowedOrigin=http://127.0.0.1:5173
```

Read `storageAccountName` and `deployedContainerName` from the deployment
outputs.

## Create a read-only SAS

Create a short-lived user-delegation SAS where possible. A container service
SAS with read permission only is acceptable for a dedicated private test
container.

The final browser base URL must end in the configured container and prefix:

```text
https://<account>.blob.core.windows.net/thimbledb/demo?<sas>
```

Required permission:

```text
sp=r
```

Do not grant write, create, delete, list, tag, or ownership permissions to the
browser SAS.

## Stage 2: deploy the authority

Set secrets in the current shell:

```powershell
$env:THIMBLE_MASTER_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
$env:THIMBLE_SESSION_SECRET = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
$env:THIMBLE_READ_BASE_URL = "https://<account>.blob.core.windows.net/thimbledb/demo?<read-only-sas>"
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
               sessionSecret=$env:THIMBLE_SESSION_SECRET `
               readBaseUrl=$env:THIMBLE_READ_BASE_URL
```

Remove shell values afterwards:

```powershell
Remove-Item Env:THIMBLE_MASTER_KEY
Remove-Item Env:THIMBLE_SESSION_SECRET
Remove-Item Env:THIMBLE_READ_BASE_URL
```

## Verify

- Container App uses HTTPS.
- Blob CORS allows only the application origin.
- Browser object requests include the container and prefix.
- The browser SAS contains `sp=r`.
- Object bodies begin with `TDB1`.
- The Container App can seed and mutate data.
- Direct browser reads cannot write or delete blobs.

## Production improvements

The current Node provider uses a storage connection string. A production Azure
adapter should use the Container App managed identity and Entra authorisation
instead of Shared Key.

Store master and session secrets in Key Vault and reference them from
Container Apps. The current Bicep accepts secure parameters to keep the example
complete but does not provision Key Vault.

Use user-delegation SAS tokens with short expiry and refresh them through the
authenticated authority.

## References

- [Azure Container Apps Bicep resources](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps)
- [Azure Blob Storage account types](https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview)
- [Azure Storage CORS](https://learn.microsoft.com/en-us/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services)
- [Azure user-delegation SAS](https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas)
