@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Lowercase application name used in resource names.')
@minLength(3)
@maxLength(20)
param appName string

@description('OCI image containing the built ThimbleDB Node authority.')
param containerImage string = ''

@description('Exact browser origin allowed to read Blob Storage.')
param allowedOrigin string

@description('Base64-encoded 32-byte deployment master key.')
@secure()
param masterKey string = ''

@description('Base64-encoded password pepper containing at least 32 bytes.')
@secure()
param passwordPepper string = ''

@description('Deploy the Container App after the image and secrets are ready.')
param deployAuthority bool = false

@description('Private Blob container name.')
param containerName string = 'thimbledb'

@description('Application prefix inside the container.')
param prefix string = 'demo'

@description('Optional Microsoft Entra tenant ID.')
param entraTenantId string = ''

@description('Optional Microsoft Entra API audience.')
param entraAudience string = ''

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
    cors: {
      corsRules: [
        {
          allowedOrigins: [
            allowedOrigin
          ]
          allowedMethods: [
            'GET'
            'HEAD'
            'OPTIONS'
          ]
          allowedHeaders: [
            'If-None-Match'
          ]
          exposedHeaders: [
            'ETag'
            'Content-Length'
          ]
          maxAgeInSeconds: 3600
        }
      ]
    }
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
        {
          name: 'password-pepper'
          value: passwordPepper
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
              name: 'THIMBLE_PASSWORD_PEPPER'
              secretRef: 'password-pepper'
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
              name: 'THIMBLE_LOCAL_REGISTRATION'
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
              name: 'THIMBLE_SECURE_COOKIES'
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
