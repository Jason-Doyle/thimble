{{- define "thimbledb.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "thimbledb.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "thimbledb.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "thimbledb.labels" -}}
helm.sh/chart: {{ include "thimbledb.chart" . }}
{{ include "thimbledb.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "thimbledb.selectorLabels" -}}
app.kubernetes.io/name: {{ include "thimbledb.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "thimbledb.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "thimbledb.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "thimbledb.validate" -}}
{{- if and (eq .Values.config.provider "local") (not .Values.localStorage.enabled) }}
{{- fail "localStorage.enabled must be true when config.provider is local" }}
{{- end }}
{{- if and (eq .Values.config.provider "local") (gt (int .Values.replicaCount) 1) }}
{{- fail "the local provider supports only one replica" }}
{{- end }}
{{- if and .Values.ingress.enabled (eq (len .Values.ingress.hosts) 0) }}
{{- fail "ingress.hosts must contain at least one host when ingress is enabled" }}
{{- end }}
{{- $oidc := .Values.config.oidc }}
{{- $oidcConfigured := or $oidc.providerId $oidc.issuer $oidc.audience $oidc.jwksUri $oidc.allowedTenants $oidc.requiredScope $oidc.requiredRole }}
{{- if and $oidcConfigured (not (and $oidc.providerId $oidc.issuer $oidc.audience $oidc.jwksUri (or $oidc.requiredScope $oidc.requiredRole))) }}
{{- fail "config.oidc requires providerId, issuer, audience, jwksUri, and at least one requiredScope or requiredRole" }}
{{- end }}
{{- end }}
