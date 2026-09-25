{{/* vim: set filetype=mustache: */}}

{{- define "ira.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ira.fullname" -}}
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

{{- define "ira.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels. Usage: include "ira.labels" (dict "ctx" $ "component" "api") */}}
{{- define "ira.labels" -}}
helm.sh/chart: {{ include "ira.chart" .ctx }}
{{ include "ira.selectorLabels" . }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/part-of: incident-response-agent
{{- end }}

{{- define "ira.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ira.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Component resource name: <fullname>-<component> */}}
{{- define "ira.componentName" -}}
{{- printf "%s-%s" (include "ira.fullname" .ctx) .component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ira.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ira.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "ira.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else if .Values.secrets.create }}
{{- printf "%s-secrets" (include "ira.fullname" .) }}
{{- else }}
{{- fail "Set existingSecret (recommended) or secrets.create=true with secrets.data" }}
{{- end }}
{{- end }}

{{/* Image reference. Usage: include "ira.imageRef" (dict "image" .Values.image "ctx" $) */}}
{{- define "ira.imageRef" -}}
{{- if .image.digest }}
{{- printf "%s@%s" .image.repository .image.digest }}
{{- else }}
{{- printf "%s:%s" .image.repository (default .ctx.Chart.AppVersion .image.tag) }}
{{- end }}
{{- end }}

{{- define "ira.corsOrigins" -}}
{{- if .Values.config.corsOrigins }}
{{- toJson .Values.config.corsOrigins }}
{{- else if .Values.ingress.host }}
{{- toJson (list (printf "https://%s" .Values.ingress.host)) }}
{{- else }}
{{- fail "Set config.corsOrigins or ingress.host" }}
{{- end }}
{{- end }}

{{/*
Non-secret environment, as a flat map of KEY: "value". Rendered into the ConfigMap and,
inline, into the migration hook Job (the ConfigMap does not exist yet on pre-install).
*/}}
{{- define "ira.configData" -}}
{{- $v := .Values -}}
{{- if and (eq $v.config.environment "prod") (ne $v.auth.mode "oidc") }}
{{- fail "auth.mode must be oidc when config.environment=prod" }}
{{- end }}
{{- if and (eq $v.auth.mode "oidc") (or (not $v.auth.oidc.issuer) (not $v.auth.oidc.audience)) }}
{{- fail "auth.oidc.issuer and auth.oidc.audience are required when auth.mode=oidc" }}
{{- end }}
ENVIRONMENT: {{ $v.config.environment | quote }}
LOG_LEVEL: {{ $v.config.logLevel | quote }}
LOG_FORMAT: {{ $v.config.logFormat | quote }}
AUTH_MODE: {{ $v.auth.mode | quote }}
OIDC_ISSUER: {{ $v.auth.oidc.issuer | quote }}
OIDC_AUDIENCE: {{ $v.auth.oidc.audience | quote }}
OIDC_CLIENT_ID: {{ $v.auth.oidc.clientId | quote }}
OIDC_SCOPES: {{ $v.auth.oidc.scopes | quote }}
OIDC_ROLES_CLAIM: {{ $v.auth.oidc.rolesClaim | quote }}
OIDC_ROLE_MAPPING: {{ toJson (default (dict) $v.auth.oidc.roleMapping) | quote }}
CORS_ORIGINS: {{ include "ira.corsOrigins" . | quote }}
POSTGRES_ENABLED: "true"
REDIS_ENABLED: "true"
QUEUE_ENABLED: "true"
NEO4J_ENABLED: {{ ternary "true" "false" $v.neo4j.enabled | quote }}
POSTGRES_HOST: {{ required "postgres.host is required" $v.postgres.host | quote }}
POSTGRES_PORT: {{ $v.postgres.port | quote }}
POSTGRES_DB: {{ $v.postgres.database | quote }}
POSTGRES_USER: {{ $v.postgres.user | quote }}
POSTGRES_SSLMODE: {{ $v.postgres.sslmode | quote }}
{{- if $v.redis.url }}
REDIS_URL: {{ $v.redis.url | quote }}
{{- end }}
{{- if $v.neo4j.enabled }}
NEO4J_URI: {{ required "neo4j.uri is required when neo4j.enabled" $v.neo4j.uri | quote }}
NEO4J_USER: {{ $v.neo4j.user | quote }}
{{- end }}
LITELLM_API_BASE: {{ required "litellm.url is required" $v.litellm.url | quote }}
{{- if $v.otel.endpoint }}
OTEL_EXPORTER_OTLP_ENDPOINT: {{ $v.otel.endpoint | quote }}
{{- end }}
ARTIFACTS_DIR: {{ $v.config.artifactsDir | quote }}
MAX_ITERATIONS: {{ $v.config.maxIterations | quote }}
MIN_CONFIDENCE: {{ $v.config.minConfidence | quote }}
MAX_BUDGET_USD: {{ $v.config.maxBudgetUsd | quote }}
APPROVAL_TIMEOUT_S: {{ $v.config.approvalTimeoutS | quote }}
EMBEDDING_MODEL: {{ $v.config.embeddingModel | quote }}
EMBEDDING_DIM: {{ $v.config.embeddingDim | quote }}
{{- range $k, $val := $v.config.extraEnv }}
{{ $k }}: {{ $val | toString | quote }}
{{- end }}
{{- end }}

{{/* Pod security context. Usage: include "ira.podSecurityContext" (dict "ctx" $ "override" (dict ...)) */}}
{{- define "ira.podSecurityContext" -}}
{{- $sc := deepCopy .ctx.Values.podSecurityContext }}
{{- $sc = mergeOverwrite $sc (default (dict) .override) }}
{{- toYaml $sc }}
{{- end }}

{{/* topologySpreadConstraints for a component, unless overridden */}}
{{- define "ira.topologySpread" -}}
{{- $c := .componentValues -}}
{{- if $c.topologySpreadConstraints }}
{{- toYaml $c.topologySpreadConstraints }}
{{- else if .ctx.Values.topologySpread.enabled }}
- maxSkew: {{ .ctx.Values.topologySpread.zone.maxSkew }}
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: {{ .ctx.Values.topologySpread.zone.whenUnsatisfiable }}
  labelSelector:
    matchLabels:
      {{- include "ira.selectorLabels" (dict "ctx" .ctx "component" .component) | nindent 6 }}
- maxSkew: {{ .ctx.Values.topologySpread.node.maxSkew }}
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: {{ .ctx.Values.topologySpread.node.whenUnsatisfiable }}
  labelSelector:
    matchLabels:
      {{- include "ira.selectorLabels" (dict "ctx" .ctx "component" .component) | nindent 6 }}
{{- end }}
{{- end }}

{{/* Artifacts volume (PVC or emptyDir) */}}
{{- define "ira.artifactsVolume" -}}
- name: artifacts
{{- if .Values.artifacts.persistence.enabled }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-artifacts" (include "ira.fullname" .)) .Values.artifacts.persistence.existingClaim }}
{{- else }}
  emptyDir:
    sizeLimit: {{ .Values.artifacts.emptyDir.sizeLimit }}
{{- end }}
- name: tmp
  emptyDir:
    sizeLimit: {{ .Values.tmp.sizeLimit }}
{{- end }}

{{- define "ira.backendVolumeMounts" -}}
- name: artifacts
  mountPath: {{ .Values.config.artifactsDir }}
- name: tmp
  mountPath: /tmp
{{- end }}

{{/* Env shared by api/worker containers (downward API) */}}
{{- define "ira.podEnv" -}}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
{{- end }}

{{/* Checksum annotations so config/secret changes roll the pods */}}
{{- define "ira.checksums" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if and .Values.secrets.create (not .Values.existingSecret) }}
checksum/secret: {{ include (print .Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end }}
{{- end }}

{{/* NetworkPolicy fragments */}}
{{- define "ira.np.egressRule" -}}
- ports:
    {{- range .ports }}
    - port: {{ . }}
      protocol: TCP
    {{- end }}
  {{- with .to }}
  to:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- define "ira.np.dns" -}}
{{- if .enabled }}
- to:
    - namespaceSelector:
        {{- toYaml .namespaceSelector | nindent 8 }}
      podSelector:
        {{- toYaml .podSelector | nindent 8 }}
  ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
{{- end }}
{{- end }}
{{- define "ira.np.peer" -}}
- namespaceSelector:
    {{- toYaml .namespaceSelector | nindent 4 }}
  podSelector:
    {{- toYaml .podSelector | nindent 4 }}
{{- end }}
