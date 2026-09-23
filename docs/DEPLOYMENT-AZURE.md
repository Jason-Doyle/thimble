# Deploy to Azure

Azure is a secondary deployment path using:

- Azure Container Apps for the Node authority and browser assets
- one Azure Blob container for encrypted application objects
- one separate private Blob container for auth records
- brokered private reads through the authority

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
$env:THIMBLE_PASSWORD_PEPPER = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
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
               passwordPepper=$env:THIMBLE_PASSWORD_PEPPER
```

Remove shell values afterwards:

```powershell
Remove-Item Env:THIMBLE_MASTER_KEY
Remove-Item Env:THIMBLE_PASSWORD_PEPPER
```

## Verify

- Container App uses HTTPS.
- Blob CORS allows only the application origin.
- The auth container is not exposed through any SAS or public endpoint.
- Browser object requests use the authenticated `/api/objects` broker.
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

User-delegation SAS tokens remain an option for public or direct-read scopes,
but are not required for private local-auth data.

## References

- [Azure Container Apps Bicep resources](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps)
- [Azure Blob Storage account types](https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview)
- [Azure Storage CORS](https://learn.microsoft.com/en-us/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services)
- [Azure user-delegation SAS](https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas)
