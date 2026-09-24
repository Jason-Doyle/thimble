@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Lowercase application name used in resource names.')
@minLength(3)
@maxLength(20)
param appName string

@description('OCI image containing the built ThimbleDB Node authority.')
param containerImage string = ''

@description('Exact browser origin accepted by the authority for mutations.')
param allowedOrigin string

@description('Base64-encoded 32-byte deployment master key.')
@secure()
param masterKey string = ''

@description('Deploy the Container App after the image and secrets are ready.')
param deployAuthority bool = false

@description('Private Blob container name.')
param containerName string = 'thimbledb'

@description('Application prefix inside the container.')
param prefix string = 'demo'

@description('Comma-separated historical key versions that remain readable.')
param readKeyVersions string = ''

@description('Current scope key version used for new writes.')
@minValue(1)
param keyVersion int = 1

@description('Comma-separated collection=layout overrides.')
param collectionLayouts string = ''

@description('Comma-separated collection=layout generations retained for rollback.')
param retiredCollectionLayouts string = ''

@description('Days during which deleted documents can be restored.')
@minValue(0)
param deleteRetentionDays int = 30

@description('Additional grace days before a tombstone leaves the live layout.')
@minValue(0)
param deleteGraceDays int = 7

@description('Optional Microsoft Entra tenant ID.')
param entraTenantId string = ''

@description('Optional Microsoft Entra API audience.')
param entraAudience string = ''

@description('Required delegated Entra scope.')
param entraRequiredScope string = ''

@description('Required Entra application role.')
param entraRequiredRole string = ''

@description('Optional generic OIDC provider ID used in the session route.')
param oidcProviderId string = ''

@description('Optional generic OIDC issuer.')
param oidcIssuer string = ''

@description('Optional generic OIDC API audience.')
param oidcAudience string = ''

@description('Optional generic OIDC JWKS URI.')
param oidcJwksUri string = ''

@description('Optional comma-separated generic OIDC tenant allowlist.')
param oidcAllowedTenants string = ''

@description('Required generic OIDC delegated scope.')
param oidcRequiredScope string = ''

@description('Required generic OIDC application role.')
param oidcRequiredRole string = ''

var compactName = toLower(replace(appName, '-', ''))
var storageName = take('${compactName}${uniqueString(resourceGroup().id)}', 24)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

resource authContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: '${containerName}-auth'
  properties: {
    publicAccess: 'None'
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-auth-ephemera'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${authContainer.name}/auth-v1/sessions/'
                '${authContainer.name}/auth-v1/rate-limits/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: '${appName}-environment'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${az.environment().suffixes.storage}'

resource app 'Microsoft.App/containerApps@2026-01-01' = if (deployAuthority) {
  name: appName
  location: location
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8787
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'storage-connection'
          value: storageConnectionString
        }
        {
          name: 'master-key'
          value: masterKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: containerImage
          env: [
            {
              name: 'THIMBLE_PROVIDER'
              value: 'azure'
            }
            {
              name: 'AZURE_STORAGE_CONNECTION_STRING'
              secretRef: 'storage-connection'
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: containerName
            }
            {
              name: 'THIMBLE_PREFIX'
              value: prefix
            }
            {
              name: 'THIMBLE_MASTER_KEY'
              secretRef: 'master-key'
            }
            {
              name: 'AZURE_AUTH_STORAGE_CONTAINER'
              value: authContainer.name
            }
            {
              name: 'THIMBLE_ALLOWED_ORIGIN'
              value: allowedOrigin
            }
            {
              name: 'THIMBLE_KEY_VERSION'
              value: string(keyVersion)
            }
            {
              name: 'THIMBLE_READ_KEY_VERSIONS'
              value: readKeyVersions
            }
            {
              name: 'THIMBLE_COLLECTION_LAYOUTS'
              value: collectionLayouts
            }
            {
              name: 'THIMBLE_RETIRED_COLLECTION_LAYOUTS'
              value: retiredCollectionLayouts
            }
            {
              name: 'THIMBLE_DELETE_RETENTION_DAYS'
              value: string(deleteRetentionDays)
            }
            {
              name: 'THIMBLE_DELETE_GRACE_DAYS'
              value: string(deleteGraceDays)
            }
            {
              name: 'THIMBLE_MAINTENANCE_MODE'
              value: 'false'
            }
            {
              name: 'ENTRA_TENANT_ID'
              value: entraTenantId
            }
            {
              name: 'ENTRA_AUDIENCE'
              value: entraAudience
            }
            {
              name: 'ENTRA_REQUIRED_SCOPE'
              value: entraRequiredScope
            }
            {
              name: 'ENTRA_REQUIRED_ROLE'
              value: entraRequiredRole
            }
            {
              name: 'OIDC_PROVIDER_ID'
              value: oidcProviderId
            }
            {
              name: 'OIDC_ISSUER'
              value: oidcIssuer
            }
            {
              name: 'OIDC_AUDIENCE'
              value: oidcAudience
            }
            {
              name: 'OIDC_JWKS_URI'
              value: oidcJwksUri
            }
            {
              name: 'OIDC_ALLOWED_TENANTS'
              value: oidcAllowedTenants
            }
            {
              name: 'OIDC_REQUIRED_SCOPE'
              value: oidcRequiredScope
            }
            {
              name: 'OIDC_REQUIRED_ROLE'
              value: oidcRequiredRole
            }
            {
              name: 'THIMBLE_SECURE_COOKIES'
              value: 'true'
            }
            {
              name: 'THIMBLE_DISABLE_IP_RATE_LIMIT'
              value: 'true'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

output storageAccountName string = storage.name
output containerAppUrl string = deployAuthority ? 'https://${app!.properties.configuration.ingress.fqdn}' : ''
output deployedContainerName string = container.name
