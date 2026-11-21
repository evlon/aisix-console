// Target catalogue, wire mapping, and client-side validation for
// `observability_exporters`.
//
// WHY THE VALIDATION IS DUPLICATED HERE
// The gateway rejects a bad exporter at load time with a schema error that
// names a JSON pointer, not a UI field. Three of these constraints trip up
// every first-time user, and all three are invisible in a plain form:
//
//   1. otlp_http.endpoint must be https:// — EXCEPT for a hard-coded local
//      allowlist (mock-otlp / otel-collector / 127.0.0.1 / localhost). A
//      self-hosted collector on `http://tempo:4318` is REJECTED.
//   2. aliyun_sls.endpoint is a HOST ONLY — no scheme. Pasting the console URL
//      `https://ap-southeast-3.log.aliyuncs.com` fails the pattern.
//   3. datadog.site is a closed enum of seven sites, not free text.
//
// Plus every inner config is `deny_unknown_fields`, so a field belonging to
// another kind is a hard error — the draft mapping below emits exactly the
// fields of the chosen kind.
//
// Mirrored from (aisix gateway):
//   crates/aisix-core/src/models/observability_exporter.rs
//     OtlpHttpConfig.endpoint      lines 53-55
//     AliyunSlsConfig.endpoint     lines 83-85
//     DatadogConfig.site           lines 133-135
//     ObjectStoreConfig.endpoint   lines 201-203
//     content_max_bytes range      1 .. 1_048_576 (and defaults of 128 KiB)

// ---- gateway constraints ----------------------------------------------------

export const OTLP_ENDPOINT_RE =
  /^https:\/\/.+|^http:\/\/(mock-otlp|otel-collector|127\.0\.0\.1|localhost)(:[0-9]+)?(\/.*)?$/;

export const SLS_ENDPOINT_RE =
  /^[a-z0-9][a-z0-9.-]*\.aliyuncs\.com$|^http:\/\/(mock-sls|127\.0\.0\.1|localhost)(:[0-9]+)?$/;

export const OBJSTORE_ENDPOINT_RE =
  /^https:\/\/.+|^http:\/\/(minio|azurite|fake-gcs-server|fake-gcs|127\.0\.0\.1|localhost)(:[0-9]+)?(\/.*)?$/;

export const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
];

export const CONTENT_MAX_BYTES_LIMIT = 1048576; // 1 MiB (gateway range max)
export const DEFAULT_CONTENT_MAX_BYTES = 131072; // 128 KiB (gateway default)

// ---- target catalogue -------------------------------------------------------
// The user picks a DESTINATION, not a `kind`. Several cards share one kind and
// differ only by endpoint template, which is exactly the knowledge that was
// missing before.

export const TARGETS = [
  {
    id: 'grafana',
    kind: 'otlp_http',
    labelKey: 'obs.targetGrafana',
    descKey: 'obs.targetGrafanaDesc',
    endpointPlaceholder: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/traces',
  },
  {
    id: 'langfuse',
    kind: 'otlp_http',
    labelKey: 'obs.targetLangfuse',
    descKey: 'obs.targetLangfuseDesc',
    endpointPlaceholder: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
  },
  {
    id: 'honeycomb',
    kind: 'otlp_http',
    labelKey: 'obs.targetHoneycomb',
    descKey: 'obs.targetHoneycombDesc',
    endpointPlaceholder: 'https://api.honeycomb.io/v1/traces',
  },
  {
    id: 'otlp',
    kind: 'otlp_http',
    labelKey: 'obs.targetOtlp',
    descKey: 'obs.targetOtlpDesc',
    endpointPlaceholder: 'http://otel-collector:4318/v1/traces',
  },
  {
    id: 'datadog',
    kind: 'datadog',
    labelKey: 'obs.targetDatadog',
    descKey: 'obs.targetDatadogDesc',
    endpointPlaceholder: 'datadoghq.com',
  },
  {
    id: 'sls',
    kind: 'aliyun_sls',
    labelKey: 'obs.targetSls',
    descKey: 'obs.targetSlsDesc',
    endpointPlaceholder: 'ap-southeast-3.log.aliyuncs.com',
  },
  {
    id: 'objectstore',
    kind: 'object_store',
    labelKey: 'obs.targetObjectStore',
    descKey: 'obs.targetObjectStoreDesc',
    endpointPlaceholder: 'https://minio.example.com',
  },
];

export function targetForKind(kind, provider) {
  if (kind === 'object_store') return TARGETS.find((t) => t.id === 'objectstore');
  return TARGETS.find((t) => t.kind === kind) ?? TARGETS[0];
}

// ---- draft (form state) -----------------------------------------------------

export function defaultDraft(kind = 'otlp_http') {
  const base = { name: '', enabled: true, kind };
  if (kind === 'otlp_http') {
    return {
      ...base,
      endpoint: '',
      headers_text: '',
      sample_rate: '',
      content_mode: 'metadata_only',
      content_max_bytes: String(DEFAULT_CONTENT_MAX_BYTES),
    };
  }
  if (kind === 'datadog') {
    return {
      ...base,
      site: 'datadoghq.com',
      credential_ref: '',
      service: '',
      ddsource: 'aisix-ai-gateway',
      tags_text: '',
      content_mode: 'metadata_only',
      content_max_bytes: String(DEFAULT_CONTENT_MAX_BYTES),
    };
  }
  if (kind === 'aliyun_sls') {
    return {
      ...base,
      endpoint: '',
      project: '',
      logstore: '',
      credential_ref: '',
      content_mode: 'metadata_only',
      content_max_bytes: String(DEFAULT_CONTENT_MAX_BYTES),
    };
  }
  return {
    ...base,
    provider: 's3',
    bucket: '',
    prefix: '',
    region: '',
    endpoint: '',
    compression: 'gzip',
    auth_mode: 'credential_ref',
    credential_ref: '',
  };
}

// Entry (resources.yaml shape) -> draft, so editing shows exactly what the
// form can round-trip.
export function draftFromEntry(entry, kind) {
  const d = { ...defaultDraft(kind), name: entry.name ?? '', enabled: entry.enabled !== false };
  if (kind === 'otlp_http') {
    d.endpoint = entry.endpoint ?? '';
    d.headers_text = formatHeaders(entry.headers);
    d.sample_rate = entry.sample_rate === undefined || entry.sample_rate === null ? '' : String(entry.sample_rate);
    d.content_mode = entry.content_mode ?? 'metadata_only';
    d.content_max_bytes = String(entry.content_max_bytes ?? DEFAULT_CONTENT_MAX_BYTES);
  } else if (kind === 'datadog') {
    d.site = entry.site ?? 'datadoghq.com';
    d.credential_ref = entry.credential_ref ?? '';
    d.service = entry.service ?? '';
    d.ddsource = entry.ddsource ?? 'aisix-ai-gateway';
    d.tags_text = formatTags(entry.tags);
    // Datadog takes content caps too; the old form never exposed it.
    d.content_mode = entry.content_mode ?? 'metadata_only';
    d.content_max_bytes = String(entry.content_max_bytes ?? DEFAULT_CONTENT_MAX_BYTES);
  } else if (kind === 'aliyun_sls') {
    d.endpoint = entry.endpoint ?? '';
    d.project = entry.project ?? '';
    d.logstore = entry.logstore ?? '';
    d.credential_ref = entry.credential_ref ?? '';
    d.content_mode = entry.content_mode ?? 'metadata_only';
    d.content_max_bytes = String(entry.content_max_bytes ?? DEFAULT_CONTENT_MAX_BYTES);
  } else {
    d.provider = entry.provider ?? 's3';
    d.bucket = entry.bucket ?? '';
    d.prefix = entry.prefix ?? '';
    d.region = entry.region ?? '';
    d.endpoint = entry.endpoint ?? '';
    d.compression = entry.compression ?? 'gzip';
    d.auth_mode = entry.auth_mode ?? 'credential_ref';
    d.credential_ref = entry.credential_ref ?? '';
  }
  return d;
}

// draft -> wire entry. Emits ONLY the fields of the chosen kind, because every
// inner config is `deny_unknown_fields`.
export function buildEntry(draft) {
  const name = String(draft.name ?? '').trim();
  const enabled = !!draft.enabled;
  const kind = draft.kind;

  if (kind === 'otlp_http') {
    return stripEmpty({
      name,
      enabled,
      kind,
      endpoint: String(draft.endpoint ?? '').trim(),
      headers: parseHeaders(draft.headers_text),
      sample_rate: draft.sample_rate === '' ? undefined : Number(draft.sample_rate),
      content_mode: draft.content_mode,
      content_max_bytes: draft.content_max_bytes === '' ? undefined : Number(draft.content_max_bytes),
    });
  }
  if (kind === 'datadog') {
    return stripEmpty({
      name,
      enabled,
      kind,
      site: String(draft.site ?? '').trim(),
      credential_ref: String(draft.credential_ref ?? '').trim(),
      service: String(draft.service ?? '').trim(),
      ddsource: String(draft.ddsource ?? '').trim(),
      tags: parseTags(draft.tags_text),
      content_mode: draft.content_mode,
      content_max_bytes: draft.content_max_bytes === '' ? undefined : Number(draft.content_max_bytes),
    });
  }
  if (kind === 'aliyun_sls') {
    return stripEmpty({
      name,
      enabled,
      kind,
      endpoint: String(draft.endpoint ?? '').trim(),
      project: String(draft.project ?? '').trim(),
      logstore: String(draft.logstore ?? '').trim(),
      credential_ref: String(draft.credential_ref ?? '').trim(),
      content_mode: draft.content_mode,
      content_max_bytes: draft.content_max_bytes === '' ? undefined : Number(draft.content_max_bytes),
    });
  }
  // object_store
  const authMode = draft.auth_mode === 'cloud_identity' ? 'cloud_identity' : 'credential_ref';
  return stripEmpty({
    name,
    enabled,
    kind,
    provider: draft.provider,
    bucket: String(draft.bucket ?? '').trim(),
    prefix: String(draft.prefix ?? '').trim(),
    region: String(draft.region ?? '').trim(),
    endpoint: String(draft.endpoint ?? '').trim(),
    compression: draft.compression,
    auth_mode: authMode,
    // Empty is correct under cloud_identity (the gateway omits it, and the
    // schema only requires it outside cloud_identity).
    credential_ref: authMode === 'cloud_identity' ? '' : String(draft.credential_ref ?? '').trim(),
  });
}

// `undefined` and `''` are dropped so optional fields stay absent rather than
// being sent blank (`region: ""` fails the gateway's min-length 1).
function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

// ---- header / tag text helpers ---------------------------------------------
// Both were raw JSON textareas. A map is easier as `Key: Value` lines and a
// list as a comma-separated line — and the tag one was actively broken: the
// form defaulted to `{}`, but `tags` is a Vec<String>, so a new Datadog
// exporter could never validate.

export function parseHeaders(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function formatHeaders(headers) {
  if (!headers || typeof headers !== 'object') return '';
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export function parseTags(text) {
  const out = String(text ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

export function formatTags(tags) {
  if (!Array.isArray(tags)) return '';
  return tags.join(', ');
}

// ---- validation -------------------------------------------------------------
// Each validator returns an i18n key suffix, or null when valid.

export function validateOtlpEndpoint(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'required';
  if (OTLP_ENDPOINT_RE.test(s)) return null;
  return s.startsWith('http://') ? 'otlpHttpNeedsHttps' : 'otlpBadUrl';
}

export function validateSlsEndpoint(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'required';
  if (SLS_ENDPOINT_RE.test(s)) return null;
  return s.includes('://') ? 'slsHostOnly' : 'slsBadHost';
}

export function validateDatadogSite(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'required';
  if (DATADOG_SITES.includes(s)) return null;
  if (/^(mock-datadog|127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(s)) return null;
  return 'ddBadSite';
}

export function validateObjectStoreEndpoint(v) {
  const s = String(v ?? '').trim();
  if (!s) return null; // optional: omit to use the provider's native endpoint
  if (OBJSTORE_ENDPOINT_RE.test(s)) return null;
  return s.startsWith('http://') ? 'objStoreHttpNeedsHttps' : 'otlpBadUrl';
}

export function validateContentMaxBytes(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'badInt';
  if (n < 1 || n > CONTENT_MAX_BYTES_LIMIT) return 'outOfRange';
  return null;
}

export function validateSampleRate(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return 'badNumber';
  if (n < 0 || n > 1) return 'outOfRange';
  return null;
}

export function validateName(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'required';
  if (s.length > 120) return 'tooLong120';
  return null;
}

/**
 * Validate a draft. Returns { field: i18nKeySuffix } — empty when valid.
 * `t` is not needed here: the component maps suffixes through `obs.err.*`.
 */
export function validateDraft(draft) {
  const errors = {};
  const set = (field, key) => {
    if (key) errors[field] = key;
  };
  set('name', validateName(draft.name));

  if (draft.kind === 'otlp_http') {
    set('endpoint', validateOtlpEndpoint(draft.endpoint));
    set('sample_rate', validateSampleRate(draft.sample_rate));
    set('content_max_bytes', validateContentMaxBytes(draft.content_max_bytes));
  } else if (draft.kind === 'datadog') {
    set('site', validateDatadogSite(draft.site));
    if (!String(draft.credential_ref ?? '').trim()) set('credential_ref', 'required');
    if (!String(draft.service ?? '').trim()) set('service', 'required');
    set('content_max_bytes', validateContentMaxBytes(draft.content_max_bytes));
  } else if (draft.kind === 'aliyun_sls') {
    set('endpoint', validateSlsEndpoint(draft.endpoint));
    if (!String(draft.project ?? '').trim()) set('project', 'required');
    if (!String(draft.logstore ?? '').trim()) set('logstore', 'required');
    if (!String(draft.credential_ref ?? '').trim()) set('credential_ref', 'required');
    set('content_max_bytes', validateContentMaxBytes(draft.content_max_bytes));
  } else {
    if (!String(draft.bucket ?? '').trim()) set('bucket', 'required');
    if (!String(draft.prefix ?? '').trim()) set('prefix', 'required');
    set('endpoint', validateObjectStoreEndpoint(draft.endpoint));
    if (draft.auth_mode !== 'cloud_identity') {
      if (!String(draft.credential_ref ?? '').trim()) set('credential_ref', 'required');
    } else if (draft.provider === 'azure_blob') {
      set('auth_mode', 'cloudIdentityS3GcsOnly');
    }
  }
  return errors;
}

// Where an exporter sends to — for the list view, which used to show only
// name/kind/enabled and so never answered "送往哪里".
export function destinationOf(entry) {
  switch (entry?.kind) {
    case 'otlp_http':
      return entry.endpoint || '';
    case 'datadog':
      return entry.site ? `Datadog · ${entry.site}` : '';
    case 'aliyun_sls':
      return entry.endpoint ? `SLS · ${entry.endpoint}` : '';
    case 'object_store': {
      const prov = entry.provider || 's3';
      return entry.bucket ? `${prov}://${entry.bucket}${entry.prefix ? '/' + entry.prefix : ''}` : prov;
    }
    default:
      return '';
  }
}

// Human summary of the privacy switch, used on the list row and in the form.
export function contentModeOf(entry) {
  const m = entry?.content_mode ?? 'metadata_only';
  return m === 'full' ? 'full' : 'metadata_only';
}
