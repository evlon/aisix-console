<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import RawYamlEditor from '../components/RawYamlEditor.vue';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const { t } = useI18n();

const KINDS = [
  { key: 'mcp_servers', label: () => t('resources.kindMcp') },
  { key: 'a2a_agents', label: () => t('resources.kindA2a') },
  { key: 'oidc_providers', label: () => t('resources.kindOidc') },
  { key: 'observability_exporters', label: () => t('resources.kindObs') },
  { key: 'claim_mappings', label: () => t('resources.kindClaim') },
  { key: 'guardrail_attachments', label: () => t('resources.kindGuardrailAttach') },
  { key: 'passthrough_routes', label: () => t('resources.kindPassthrough') },
  { key: 'mcp_auth_settings', label: () => t('resources.kindMcpAuth') },
];

const IDENTITY = {
  mcp_servers: 'name',
  a2a_agents: 'name',
  oidc_providers: 'name',
  observability_exporters: 'name',
  claim_mappings: 'name',
  guardrail_attachments: null, // composite: guardrail_id + scope_type + scope_id
  passthrough_routes: 'name',
  mcp_auth_settings: null, // singleton
};

// Compute a stable URL identity for an entry, mirroring the backend
// `identityOf` (composite triple for attachments, fixed for the singleton).
function urlIdentityOf(e) {
  const k = activeKind.value;
  if (k === 'mcp_auth_settings') return 'mcp_auth_settings';
  if (k === 'guardrail_attachments') {
    const g = e?.guardrail_id ?? '';
    const t = e?.scope_type ?? '';
    const s = e?.scope_id ?? '-';
    return `${g}/${t}/${s}`;
  }
  const field = IDENTITY[k];
  return e?.[field] ?? e?.name ?? e?.display_name ?? '';
}

const activeKind = ref(KINDS[0].key);
const entries = ref([]);
const apiKeys = ref([]);
const apiKeyIds = ref([]); // [{ identity, id }] for name->UUID (mcp_auth_settings)
const providerKeys = ref([]); // provider_key display_name list (passthrough_routes)
const loading = ref(false);

// Name lists for cross-collection reference dropdowns (P1). Each key maps to
// the identity field of that referenced collection; `teams` is synthesized
// from api_keys[].team_id (the only file-side team source).
const LOOKUP_KINDS = {
  provider_keys: 'display_name',
  models: 'display_name',
  api_keys: 'display_name',
  guardrails: 'name',
  mcp_servers: 'name',
  oidc_providers: 'name',
  passthrough_routes: 'name',
};
const lookups = ref({}); // kind -> [identity, ...]
const teamNames = ref([]); // distinct api_keys[].team_id (guardrail_attachments scope_type: team)
const editing = ref(null); // { original, entry }
const saving = ref(false);
const lastResult = ref(null);
const tab = ref('form');
const rawText = ref('');

const kindOf = (key) => KINDS.find((k) => k.key === key);

function emptyEntry() {
  const k = activeKind.value;
  if (k === 'mcp_servers') {
    return {
      name: '', type: 'mcp', url: '', transport: 'streamable_http',
      auth_type: 'none', secret: '', client_id: '', token_url: '', scopes: [''],
      spec_text: '', api_key_header: '', timeout_ms: '', enabled: true,
      forward_client_headers: '',
    };
  }
  if (k === 'a2a_agents') {
    return {
      name: '', url: '', protocol_version: '1.0',
      auth_type: 'none', secret: '', timeout_ms: '', enabled: true,
      forward_client_headers: '',
    };
  }
  if (k === 'oidc_providers') {
    return {
      name: '', issuer: '', audiences: [''], jwks_uri: '', identity_claim: 'sub',
      required_scopes: [''], bound_claims_text: '{}', leeway_secs: 0, enabled: true,
      hmac_secret: '',
    };
  }
  if (k === 'observability_exporters') {
    return {
      name: '', enabled: true, kind: 'otlp_http',
      endpoint: '', headers_text: '{}', sample_rate: '', content_mode: 'metadata_only', content_max_bytes: '',
      project: '', logstore: '', credential_ref: '',
      provider: 's3', bucket: '', prefix: '', region: '', compression: 'gzip', auth_mode: 'credential_ref',
      site: '', service: '', ddsource: '', tags_text: '{}',
    };
  }
  if (k === 'guardrail_attachments') {
    return {
      guardrail_id: '', scope_type: 'model', scope_id: '', priority: 0, enabled: true,
    };
  }
  if (k === 'passthrough_routes') {
    return {
      name: '', path_prefix: '', hosts: '', target_url: '', preserve_host: false,
      auth_mode: 'gateway_key', auth_header_name: '', anonymous_key: '',
      source_cidrs: '', credential_mode: 'inject', provider_key: '',
      identity_header: '', forward_client_headers: '', timeout_ms: '', enabled: true,
    };
  }
  if (k === 'mcp_auth_settings') {
    return {
      resource_url: '', anonymous_enabled: false, anonymous_api_key: '',
      anonymous_source_cidrs: '', anonymous_servers: '', anonymous_aggregate_entry: false,
    };
  }
  // claim_mappings
  return {
    name: '', jwt_provider: '', priority: 0,
    match: [{ claim: '', op: 'exact', values: [''] }],
    resolve_api_key: '', enabled: true,
  };
}

const form = ref(emptyEntry());

function parseJsonObj(text, label) {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

const strArr = (v) =>
  String(v || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function clean(o) {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
  }
  return o;
}

function openCreate() {
  form.value = emptyEntry();
  editing.value = { original: null };
  lastResult.value = null;
  tab.value = 'form';
  rawText.value = '';
}

function openEdit(e) {
  editing.value = { original: e };
  const f = JSON.parse(JSON.stringify(e));
  const k = activeKind.value;
  if (k === 'mcp_servers') {
    f.spec_text = e.spec ? JSON.stringify(e.spec, null, 2) : '';
    f.scopes = e.scopes?.length ? e.scopes : [''];
    if (!f.auth_type) f.auth_type = 'none';
    if (!f.name && e.display_name) f.name = e.display_name;
    f.forward_client_headers = (e.forward_client_headers ?? []).join(', ');
  }
  if (k === 'a2a_agents') {
    if (!f.auth_type) f.auth_type = 'none';
    if (!f.name && e.display_name) f.name = e.display_name;
    f.forward_client_headers = (e.forward_client_headers ?? []).join(', ');
  }
  if (k === 'oidc_providers') {
    f.audiences = e.audiences?.length ? e.audiences : [''];
    f.required_scopes = e.required_scopes?.length ? e.required_scopes : [''];
    f.bound_claims_text = e.bound_claims ? JSON.stringify(e.bound_claims, null, 2) : '{}';
    if (f.leeway_secs === undefined) f.leeway_secs = 0;
    f.hmac_secret = e.hmac_secret ?? '';
  }
  if (k === 'observability_exporters') {
    f.headers_text = e.headers ? JSON.stringify(e.headers, null, 2) : '{}';
    f.tags_text = e.tags ? JSON.stringify(e.tags, null, 2) : '{}';
  }
  if (k === 'claim_mappings') {
    f.match = e.match?.length ? e.match.map((m) => ({
      claim: m.claim, op: m.op || 'exact', values: m.values?.length ? m.values : [''],
    })) : [{ claim: '', op: 'exact', values: [''] }];
    f.resolve_api_key = e.resolve?.api_key ?? e.resolve?.api_key_id ?? '';
  }
  if (k === 'guardrail_attachments') {
    f.guardrail_id = e.guardrail_id ?? '';
    f.scope_type = e.scope_type ?? 'model';
    f.scope_id = e.scope_id ?? '';
    f.priority = e.priority ?? 0;
  }
  if (k === 'passthrough_routes') {
    f.hosts = (e.hosts ?? []).join(', ');
    f.path_prefix = e.path_prefix ?? '';
    f.target_url = e.target_url ?? '';
    f.preserve_host = !!e.preserve_host;
    f.auth_mode = e.auth_mode ?? 'gateway_key';
    f.auth_header_name = e.auth_header_name ?? '';
    f.anonymous_key = e.anonymous_key ?? e.anonymous_key_id ?? '';
    f.source_cidrs = (e.source_cidrs ?? []).join(', ');
    f.credential_mode = e.credential_mode ?? 'inject';
    f.provider_key = e.provider_key ?? e.provider_key_id ?? '';
    f.identity_header = e.identity_header ?? '';
    f.forward_client_headers = (e.forward_client_headers ?? []).join(', ');
    f.timeout_ms = e.timeout_ms ?? '';
  }
  if (k === 'mcp_auth_settings') {
    f.resource_url = e.resource_url ?? '';
    f.anonymous_enabled = !!e.anonymous?.enabled;
    // The form stores the api_key NAME; map an existing api_key_id back to its
    // name so the picker shows the current value (falls back to the raw id if
    // we can't resolve it, e.g. the id names a key outside this file).
    const rawId = e.anonymous?.api_key_id ?? e.anonymous?.api_key ?? '';
    f.anonymous_api_key = apiKeyIds.value.find((r) => r.id === rawId)?.identity ?? rawId;
    f.anonymous_source_cidrs = (e.anonymous?.source_cidrs ?? []).join(', ');
    f.anonymous_servers = (e.anonymous?.servers ?? []).join(', ');
    f.anonymous_aggregate_entry = !!e.anonymous?.aggregate_entry;
  }
  form.value = f;
  lastResult.value = null;
  tab.value = 'form';
  rawText.value = stringifyYaml(e, { lineWidth: 0 });
}

function buildEntry() {
  const f = JSON.parse(JSON.stringify(form.value));
  const k = activeKind.value;

  if (k === 'mcp_servers') {
    const out = clean({
      name: f.name,
      type: f.type,
      url: f.url,
      transport: f.transport || 'streamable_http',
      auth_type: f.auth_type || 'none',
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
    });
    if (f.auth_type !== 'none') out.secret = f.secret;
    if (f.auth_type === 'oauth2') {
      out.client_id = f.client_id;
      out.token_url = f.token_url;
      const scopes = (f.scopes || []).map((s) => s.trim()).filter(Boolean);
      if (scopes.length) out.scopes = scopes;
    }
    if (f.type === 'openapi') {
      out.spec = parseJsonObj(f.spec_text, 'spec');
      if (f.auth_type === 'api_key') out.api_key_header = f.api_key_header;
    }
    const fch = strArr(f.forward_client_headers);
    if (fch.length) out.forward_client_headers = fch;
    return out;
  }

  if (k === 'a2a_agents') {
    const fch = strArr(f.forward_client_headers);
    return clean({
      name: f.name,
      url: f.url,
      protocol_version: f.protocol_version || '1.0',
      auth_type: f.auth_type || 'none',
      secret: f.auth_type !== 'none' ? f.secret : undefined,
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
      forward_client_headers: fch.length ? fch : undefined,
    });
  }

  if (k === 'oidc_providers') {
    const audiences = (f.audiences || []).map((a) => a.trim()).filter(Boolean);
    if (!audiences.length && !f.hmac_secret) throw new Error('audiences (or hmac_secret)');
    return clean({
      name: f.name,
      issuer: f.issuer,
      audiences,
      jwks_uri: f.jwks_uri,
      identity_claim: f.identity_claim,
      required_scopes: (f.required_scopes || []).map((s) => s.trim()).filter(Boolean),
      bound_claims: parseJsonObj(f.bound_claims_text, 'bound_claims'),
      leeway_secs: f.leeway_secs !== '' ? Number(f.leeway_secs) : undefined,
      enabled: !!f.enabled,
      hmac_secret: f.hmac_secret || undefined,
    });
  }

  if (k === 'observability_exporters') {
    const base = { name: f.name, enabled: !!f.enabled, kind: f.kind };
    let cfg = {};
    if (f.kind === 'otlp_http') {
      cfg = clean({
        endpoint: f.endpoint,
        headers: parseJsonObj(f.headers_text, 'headers'),
        sample_rate: f.sample_rate !== '' ? Number(f.sample_rate) : undefined,
        content_mode: f.content_mode,
        content_max_bytes: f.content_max_bytes !== '' ? Number(f.content_max_bytes) : undefined,
      });
    } else if (f.kind === 'aliyun_sls') {
      cfg = clean({
        endpoint: f.endpoint,
        project: f.project,
        logstore: f.logstore,
        credential_ref: f.credential_ref,
        content_mode: f.content_mode,
        content_max_bytes: f.content_max_bytes !== '' ? Number(f.content_max_bytes) : undefined,
      });
    } else if (f.kind === 'object_store') {
      cfg = clean({
        provider: f.provider,
        bucket: f.bucket,
        prefix: f.prefix,
        region: f.region,
        endpoint: f.endpoint,
        compression: f.compression,
        auth_mode: f.auth_mode,
        credential_ref: f.credential_ref,
      });
    } else if (f.kind === 'datadog') {
      cfg = clean({
        site: f.site,
        credential_ref: f.credential_ref,
        service: f.service,
        ddsource: f.ddsource,
        tags: parseJsonObj(f.tags_text, 'tags'),
        content_mode: f.content_mode,
      });
    }
    return { ...base, ...cfg };
  }

  if (k === 'guardrail_attachments') {
    if (!f.guardrail_id) throw new Error('guardrail_id');
    return clean({
      guardrail_id: f.guardrail_id,
      scope_type: f.scope_type,
      scope_id: f.scope_type === 'env' ? undefined : f.scope_id,
      priority: f.priority !== '' ? Number(f.priority) : 0,
      enabled: !!f.enabled,
    });
  }

  if (k === 'passthrough_routes') {
    const hosts = strArr(f.hosts);
    if (!f.path_prefix && !hosts.length) throw new Error('path_prefix (or hosts)');
    // Exactly one of target_url / preserve_host.
    if (!f.target_url && !f.preserve_host) throw new Error('target_url (or preserve_host)');
    if (f.preserve_host && !hosts.length) throw new Error('hosts (required with preserve_host)');

    const authMode = f.auth_mode || 'gateway_key';
    const credentialMode = f.credential_mode || 'inject';
    if (authMode === 'header_key' && !f.auth_header_name) throw new Error('auth_header_name');
    if (authMode === 'anonymous') {
      if (!f.anonymous_key) throw new Error('anonymous_key');
      const cidrs = strArr(f.source_cidrs);
      if (!cidrs.length) throw new Error('source_cidrs');
    }
    if (credentialMode === 'inject' && !f.provider_key) throw new Error('provider_key');

    const out = clean({
      name: f.name,
      path_prefix: f.path_prefix || undefined,
      hosts: hosts.length ? hosts : undefined,
      target_url: f.target_url || undefined,
      preserve_host: f.preserve_host ? true : undefined,
      auth_mode: authMode === 'gateway_key' ? undefined : authMode,
      auth_header_name: f.auth_header_name || undefined,
      anonymous_key: authMode === 'anonymous' ? f.anonymous_key : undefined,
      source_cidrs: strArr(f.source_cidrs).length ? strArr(f.source_cidrs) : undefined,
      credential_mode: credentialMode === 'inject' ? undefined : credentialMode,
      provider_key: credentialMode === 'inject' ? f.provider_key : undefined,
      identity_header: f.identity_header || undefined,
      forward_client_headers: strArr(f.forward_client_headers).length ? strArr(f.forward_client_headers) : undefined,
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
    });
    return out;
  }

  if (k === 'mcp_auth_settings') {
    const out = clean({ resource_url: f.resource_url || undefined });
    if (f.anonymous_enabled) {
      const cidrs = strArr(f.anonymous_source_cidrs);
      const servers = strArr(f.anonymous_servers);
      if (!f.anonymous_api_key) throw new Error('anonymous.api_key_id');
      if (!cidrs.length) throw new Error('anonymous.source_cidrs');
      if (!servers.length) throw new Error('anonymous.servers');
      // The form holds the api_key NAME; resolve to the canonical UUID the
      // gateway expects (upstream has no name sugar for this field). If the
      // value is already a UUID (e.g. pasted), pass it through unchanged.
      const idRow = apiKeyIds.value.find((r) => r.identity === f.anonymous_api_key);
      const apiKeyId = idRow ? idRow.id : f.anonymous_api_key;
      out.anonymous = {
        enabled: true,
        api_key_id: apiKeyId,
        source_cidrs: cidrs,
        servers,
      };
      if (f.anonymous_aggregate_entry) out.anonymous.aggregate_entry = true;
    }
    return out;
  }

  // claim_mappings
  if (!f.name || !f.jwt_provider) throw new Error(t('common.required'));
  if (!f.resolve_api_key) throw new Error('resolve.api_key');
  const matches = (f.match || [])
    .filter((m) => m.claim && m.claim.trim())
    .map((m) => ({
      claim: m.claim.trim(),
      op: m.op || 'exact',
      values: (m.values || []).map((v) => v.trim()).filter(Boolean),
    }))
    .filter((m) => m.values.length);
  if (!matches.length) throw new Error('match');
  return clean({
    name: f.name,
    jwt_provider: f.jwt_provider,
    priority: f.priority !== '' ? Number(f.priority) : 0,
    match: matches,
    resolve: { api_key: f.resolve_api_key },
    enabled: !!f.enabled,
  });
}

async function load() {
  loading.value = true;
  try {
    const [r, k, ids, ...lookupResults] = await Promise.all([
      api.list(activeKind.value),
      api.list('api_keys'),
      api.derivedIds('api_keys'),
      ...Object.keys(LOOKUP_KINDS).map((lk) => api.list(lk)),
    ]);
    entries.value = r.entries ?? [];
    apiKeys.value = (k.entries ?? []).map((e) => e.display_name || e.key_hash?.slice(0, 8)).filter(Boolean);
    apiKeyIds.value = ids.rows ?? [];
    teamNames.value = [...new Set((k.entries ?? []).map((e) => e.team_id).filter(Boolean))];
    providerKeys.value = (lookupResults[0].entries ?? []).map((e) => e.display_name || e.name).filter(Boolean);
    const lk = {};
    Object.keys(LOOKUP_KINDS).forEach((kind, i) => {
      const field = LOOKUP_KINDS[kind];
      lk[kind] = (lookupResults[i].entries ?? [])
        .map((e) => e[field] ?? e.name ?? e.display_name)
        .filter(Boolean);
    });
    lookups.value = lk;
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function switchKind() {
  lastResult.value = null;
  editing.value = null;
  load();
}

async function save() {
  const k = activeKind.value;
  if (k !== 'mcp_auth_settings' && k !== 'guardrail_attachments' && !form.value.name && !form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: t('common.required') }] };
    return;
  }
  let entry;
  try {
    entry = buildEntry();
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
    return;
  }
  saving.value = true;
  try {
    const original = editing.value?.original;
    const identity = original ? urlIdentityOf(original) : '';
    const result = identity
      ? await api.update(activeKind.value, identity, entry)
      : await api.create(activeKind.value, entry);
    lastResult.value = result;
    if (result.ok) {
      editing.value = null;
      await load();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function saveRaw() {
  let entry;
  try {
    entry = parseYaml(rawText.value || '', { uniqueKeys: true });
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: `YAML: ${e.message}` }] };
    return;
  }
  saving.value = true;
  try {
    const original = editing.value?.original;
    const identity = original ? urlIdentityOf(original) : '';
    const result = identity
      ? await api.update(activeKind.value, identity, entry)
      : await api.create(activeKind.value, entry);
    lastResult.value = result;
    if (result.ok) {
      editing.value = null;
      await load();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function remove(e) {
  const identity = urlIdentityOf(e);
  if (!confirm(`${kindOf(activeKind.value).label()} "${identity}"?`)) return;
  try {
    const r = await api.remove(activeKind.value, identity);
    lastResult.value = r;
    if (r.ok) await load();
  } catch (err) {
    lastResult.value = { ok: false, errors: [{ message: err.message }] };
  }
}

function tableCols() {
  const k = activeKind.value;
  if (k === 'mcp_servers') return ['name', 'type', 'url', 'auth_type', 'enabled'];
  if (k === 'a2a_agents') return ['name', 'url', 'protocol_version', 'auth_type', 'enabled'];
  if (k === 'oidc_providers') return ['name', 'issuer', 'identity_claim', 'enabled'];
  if (k === 'observability_exporters') return ['name', 'kind', 'enabled'];
  if (k === 'guardrail_attachments') return ['guardrail_id', 'scope_type', 'scope_id', 'priority', 'enabled'];
  if (k === 'passthrough_routes') return ['name', 'path_prefix', 'target_url', 'enabled'];
  if (k === 'mcp_auth_settings') return ['resource_url', 'anonymous'];
  return ['name', 'jwt_provider', 'priority', 'enabled'];
}

function cell(e, col) {
  if (col === 'enabled') return e.enabled ? t('common.enabled') : t('common.disabled');
  if (col === 'anonymous') return e.anonymous ? t('common.enabled') : t('common.disabled');
  if (col === 'display_name' || col === 'name') return e.display_name ?? e.name ?? '—';
  return e[col] ?? '—';
}

onMounted(load);
</script>

<template>
  <div>
    <div style="display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap">
      <button
        v-for="k in KINDS"
        :key="k.key"
        :class="{ primary: activeKind === k.key }"
        @click="activeKind = k.key; switchKind()"
      >
        {{ k.label() }}
      </button>
    </div>

    <div v-if="lastResult && !lastResult.ok" class="error-box">
      <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <h3 style="margin: 0">{{ kindOf(activeKind).label() }}</h3>
        <button class="primary" @click="openCreate">+ {{ t('common.add') }}</button>
      </div>
      <p class="muted" style="margin-bottom: 0">{{ t('resources.hint') }}</p>
      <table style="margin-top: 12px">
        <thead>
          <tr>
            <th v-for="c in tableCols()" :key="c">{{ c === 'display_name' || c === 'name' ? t('common.name') : c === 'enabled' ? t('common.status') : c }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td :colspan="tableCols().length + 1" class="muted">{{ t('resources.empty') }}</td>
          </tr>
          <tr v-for="(e, i) in entries" :key="i">
            <td v-for="c in tableCols()" :key="c">{{ cell(e, c) }}</td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">{{ t('common.edit') }}</button>
              <button class="danger" @click="remove(e)">{{ t('common.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="(editing.original ? t('resources.edit') : t('resources.add')) + ' — ' + kindOf(activeKind).label()" @close="editing = null">
      <div style="margin-bottom: 12px">
        <button :class="{ primary: tab === 'form' }" style="margin-right: 6px" @click="tab = 'form'">{{ t('resources.tabForm') }}</button>
        <button :class="{ primary: tab === 'raw' }" @click="tab = 'raw'">{{ t('resources.tabRaw') }}</button>
      </div>

      <template v-if="tab === 'form'">
        <!-- mcp servers -->
        <template v-if="activeKind === 'mcp_servers'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>type</label>
            <select v-model="form.type">
              <option value="mcp">mcp</option>
              <option value="openapi">openapi</option>
            </select>
          </div>
          <div class="form-row">
            <label>url *</label>
            <input v-model="form.url" placeholder="https://…/mcp" />
          </div>
          <div class="form-row">
            <label>transport</label>
            <select v-model="form.transport">
              <option value="streamable_http">streamable_http</option>
            </select>
          </div>
          <div class="form-row">
            <label>auth_type</label>
            <select v-model="form.auth_type">
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="api_key">api_key</option>
              <option value="oauth2">oauth2</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_type !== 'none'">
            <label>secret</label>
            <input v-model="form.secret" />
          </div>
          <div class="form-row" v-if="form.auth_type === 'oauth2'">
            <label>client_id</label>
            <input v-model="form.client_id" />
          </div>
          <div class="form-row" v-if="form.auth_type === 'oauth2'">
            <label>token_url</label>
            <input v-model="form.token_url" />
          </div>
          <div class="form-row" v-if="form.auth_type === 'oauth2'">
            <label>scopes</label>
            <div style="flex: 1">
              <div v-for="(s, i) in form.scopes" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.scopes[i]" style="flex: 1" />
                <button @click="form.scopes.splice(i, 1)">✕</button>
              </div>
              <button @click="form.scopes.push('')">+</button>
            </div>
          </div>
          <div class="form-row" v-if="form.type === 'openapi'">
            <label>spec (JSON) *</label>
            <textarea v-model="form.spec_text" rows="5" style="flex: 1" placeholder='{"openapi":"3.0.0",…}' />
          </div>
          <div class="form-row" v-if="form.type === 'openapi' && form.auth_type === 'api_key'">
            <label>api_key_header</label>
            <input v-model="form.api_key_header" placeholder="X-API-Key" />
          </div>
          <div class="form-row">
            <label>timeout_ms</label>
            <input v-model="form.timeout_ms" type="number" />
          </div>
          <div class="form-row">
            <label>forward_client_headers</label>
            <input v-model="form.forward_client_headers" placeholder="x-user-id, x-tenant (逗号分隔)" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- a2a agents -->
        <template v-else-if="activeKind === 'a2a_agents'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>url *</label>
            <input v-model="form.url" placeholder="https://…/a2a" />
          </div>
          <div class="form-row">
            <label>protocol_version</label>
            <select v-model="form.protocol_version">
              <option value="1.0">1.0</option>
              <option value="0.3">0.3</option>
            </select>
          </div>
          <div class="form-row">
            <label>auth_type</label>
            <select v-model="form.auth_type">
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="api_key">api_key</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_type !== 'none'">
            <label>secret</label>
            <input v-model="form.secret" />
          </div>
          <div class="form-row">
            <label>timeout_ms</label>
            <input v-model="form.timeout_ms" type="number" />
          </div>
          <div class="form-row">
            <label>forward_client_headers</label>
            <input v-model="form.forward_client_headers" placeholder="x-user-id, x-tenant (逗号分隔)" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- oidc providers -->
        <template v-else-if="activeKind === 'oidc_providers'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>issuer *</label>
            <input v-model="form.issuer" placeholder="https://…" />
          </div>
          <div class="form-row">
            <label>audiences *</label>
            <div style="flex: 1">
              <div v-for="(a, i) in form.audiences" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.audiences[i]" style="flex: 1" />
                <button @click="form.audiences.splice(i, 1)">✕</button>
              </div>
              <button @click="form.audiences.push('')">+</button>
            </div>
          </div>
          <div class="form-row">
            <label>jwks_uri</label>
            <input v-model="form.jwks_uri" />
          </div>
          <div class="form-row">
            <label>hmac_secret</label>
            <input v-model="form.hmac_secret" type="password" placeholder="共享密钥（HS256/384/512，≥32 字节）；设置后 issuer/audiences 可留空" />
          </div>
          <div class="form-row">
            <label>identity_claim</label>
            <input v-model="form.identity_claim" placeholder="sub" />
          </div>
          <div class="form-row">
            <label>required_scopes</label>
            <div style="flex: 1">
              <div v-for="(s, i) in form.required_scopes" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.required_scopes[i]" style="flex: 1" />
                <button @click="form.required_scopes.splice(i, 1)">✕</button>
              </div>
              <button @click="form.required_scopes.push('')">+</button>
            </div>
          </div>
          <div class="form-row">
            <label>bound_claims (JSON)</label>
            <textarea v-model="form.bound_claims_text" rows="4" style="flex: 1" placeholder='{"claim":"value"}' />
          </div>
          <div class="form-row">
            <label>leeway_secs</label>
            <input v-model="form.leeway_secs" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- observability exporters -->
        <template v-else-if="activeKind === 'observability_exporters'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>kind</label>
            <select v-model="form.kind">
              <option value="otlp_http">otlp_http</option>
              <option value="aliyun_sls">aliyun_sls</option>
              <option value="object_store">object_store</option>
              <option value="datadog">datadog</option>
            </select>
          </div>

          <template v-if="form.kind === 'otlp_http'">
            <div class="form-row">
              <label>endpoint *</label>
              <input v-model="form.endpoint" />
            </div>
            <div class="form-row">
              <label>headers (JSON)</label>
              <textarea v-model="form.headers_text" rows="3" style="flex: 1" placeholder='{"Authorization":"…"}' />
            </div>
          </template>

          <template v-else-if="form.kind === 'aliyun_sls'">
            <div class="form-row">
              <label>endpoint *</label>
              <input v-model="form.endpoint" />
            </div>
            <div class="form-row">
              <label>project *</label>
              <input v-model="form.project" />
            </div>
            <div class="form-row">
              <label>logstore *</label>
              <input v-model="form.logstore" />
            </div>
          </template>

          <template v-else-if="form.kind === 'object_store'">
            <div class="form-row">
              <label>provider</label>
              <select v-model="form.provider">
                <option value="s3">s3</option>
                <option value="gcs">gcs</option>
                <option value="azure_blob">azure_blob</option>
              </select>
            </div>
            <div class="form-row">
              <label>bucket *</label>
              <input v-model="form.bucket" />
            </div>
            <div class="form-row">
              <label>prefix</label>
              <input v-model="form.prefix" />
            </div>
            <div class="form-row">
              <label>region</label>
              <input v-model="form.region" />
            </div>
            <div class="form-row">
              <label>endpoint</label>
              <input v-model="form.endpoint" />
            </div>
            <div class="form-row">
              <label>compression</label>
              <select v-model="form.compression">
                <option value="gzip">gzip</option>
                <option value="none">none</option>
              </select>
            </div>
            <div class="form-row">
              <label>auth_mode</label>
              <select v-model="form.auth_mode">
                <option value="credential_ref">credential_ref</option>
                <option value="cloud_identity">cloud_identity</option>
              </select>
            </div>
          </template>

          <template v-else-if="form.kind === 'datadog'">
            <div class="form-row">
              <label>site *</label>
              <input v-model="form.site" placeholder="datadoghq.com / us3.datadoghq.com / …" />
            </div>
            <div class="form-row">
              <label>service</label>
              <input v-model="form.service" />
            </div>
            <div class="form-row">
              <label>ddsource</label>
              <input v-model="form.ddsource" />
            </div>
            <div class="form-row">
              <label>tags (JSON)</label>
              <textarea v-model="form.tags_text" rows="3" style="flex: 1" placeholder='{"env":"prod"}' />
            </div>
          </template>

          <div class="form-row" v-if="['aliyun_sls', 'object_store', 'datadog'].includes(form.kind)">
            <label>credential_ref</label>
            <input v-model="form.credential_ref" />
          </div>
          <div class="form-row" v-if="form.kind === 'otlp_http'">
            <label>sample_rate</label>
            <input v-model="form.sample_rate" type="number" placeholder="0-1" />
          </div>
          <div class="form-row" v-if="['otlp_http', 'aliyun_sls', 'datadog'].includes(form.kind)">
            <label>content_mode</label>
            <select v-model="form.content_mode">
              <option value="metadata_only">metadata_only</option>
              <option value="full">full</option>
            </select>
          </div>
          <div class="form-row" v-if="['otlp_http', 'aliyun_sls'].includes(form.kind)">
            <label>content_max_bytes</label>
            <input v-model="form.content_max_bytes" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- guardrail attachments -->
        <template v-else-if="activeKind === 'guardrail_attachments'">
          <div class="form-row">
            <label>guardrail_id *</label>
            <select v-model="form.guardrail_id">
              <option value="">选择护栏…</option>
              <option v-for="g in lookups.guardrails" :key="g" :value="g">{{ g }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>scope_type *</label>
            <select v-model="form.scope_type">
              <option value="env">env</option>
              <option value="model">model</option>
              <option value="mcp_server">mcp_server</option>
              <option value="api_key">api_key</option>
              <option value="team">team</option>
              <option value="passthrough_route">passthrough_route</option>
            </select>
          </div>
          <div class="form-row" v-if="form.scope_type === 'model'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择模型…</option>
              <option v-for="m in lookups.models" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'mcp_server'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择 MCP 服务器…</option>
              <option v-for="m in lookups.mcp_servers" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'api_key'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择调用方密钥…</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'team'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择团队…</option>
              <option v-for="t in teamNames" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'passthrough_route'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择透传路由…</option>
              <option v-for="p in lookups.passthrough_routes" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>priority</label>
            <input v-model="form.priority" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- passthrough routes -->
        <template v-else-if="activeKind === 'passthrough_routes'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>path_prefix</label>
            <input v-model="form.path_prefix" placeholder="/passthrough/openai（以 / 开头）" />
          </div>
          <div class="form-row">
            <label>hosts</label>
            <input v-model="form.hosts" placeholder="api.example.com, *.corp.com（逗号分隔）" />
          </div>
          <div class="form-row">
            <label>target_url</label>
            <input v-model="form.target_url" placeholder="https://upstream.example.com（与 preserve_host 二选一）" />
          </div>
          <div class="form-row">
            <label>preserve_host</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.preserve_host" /></label>
          </div>
          <div class="form-row">
            <label>auth_mode</label>
            <select v-model="form.auth_mode">
              <option value="gateway_key">gateway_key（标准网关凭证）</option>
              <option value="header_key">header_key（专用头）</option>
              <option value="anonymous">anonymous（匿名主体）</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_mode === 'header_key'">
            <label>auth_header_name *</label>
            <input v-model="form.auth_header_name" placeholder="x-aisix-api-key" />
          </div>
          <div class="form-row" v-if="form.auth_mode === 'anonymous'">
            <label>anonymous_key *</label>
            <select v-model="form.anonymous_key">
              <option value="">{{ t('resources.chooseKey') }}</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_mode === 'anonymous'">
            <label>source_cidrs *</label>
            <input v-model="form.source_cidrs" placeholder="10.0.0.0/8, 127.0.0.1/32（逗号分隔）" />
          </div>
          <div class="form-row">
            <label>credential_mode</label>
            <select v-model="form.credential_mode">
              <option value="inject">inject（注入 ProviderKey 密钥）</option>
              <option value="forward_client">forward_client（转发调用方凭证）</option>
            </select>
          </div>
          <div class="form-row" v-if="form.credential_mode === 'inject'">
            <label>provider_key *</label>
            <select v-model="form.provider_key">
              <option value="">选择 ProviderKey…</option>
              <option v-for="p in providerKeys" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>identity_header</label>
            <input v-model="form.identity_header" placeholder="x-aisix-user（可选）" />
          </div>
          <div class="form-row">
            <label>forward_client_headers</label>
            <input v-model="form.forward_client_headers" placeholder="x-trace-*（逗号分隔 glob，可选）" />
          </div>
          <div class="form-row">
            <label>timeout_ms</label>
            <input v-model="form.timeout_ms" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- mcp auth settings (singleton) -->
        <template v-else-if="activeKind === 'mcp_auth_settings'">
          <div class="form-row">
            <label>resource_url</label>
            <input v-model="form.resource_url" placeholder="https://gw.example.com/mcp" />
          </div>
          <div class="form-row">
            <label>anonymous.enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.anonymous_enabled" /></label>
          </div>
          <template v-if="form.anonymous_enabled">
            <div class="form-row">
              <label>anonymous.api_key_id *</label>
              <select v-model="form.anonymous_api_key">
                <option value="">{{ t('resources.chooseKey') }}</option>
                <option v-for="r in apiKeyIds" :key="r.id" :value="r.identity">{{ r.identity }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>anonymous.source_cidrs *</label>
              <input v-model="form.anonymous_source_cidrs" placeholder="0.0.0.0/0, ::/0（逗号分隔）" />
            </div>
            <div class="form-row">
              <label>anonymous.servers *</label>
              <input v-model="form.anonymous_servers" placeholder="demo-mcp, another-mcp（逗号分隔）" />
            </div>
            <div class="form-row">
              <label>anonymous.aggregate_entry</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.anonymous_aggregate_entry" /></label>
            </div>
          </template>
        </template>

        <!-- claim mappings -->
        <template v-else-if="activeKind === 'claim_mappings'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>jwt_provider *</label>
            <select v-model="form.jwt_provider">
              <option value="">选择 OIDC 提供方…</option>
              <option v-for="o in lookups.oidc_providers" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>priority</label>
            <input v-model="form.priority" type="number" />
          </div>
          <div class="form-row">
            <label>match *</label>
            <div style="flex: 1">
              <div v-for="(m, i) in form.match" :key="i" style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 8px">
                <div style="display: flex; gap: 6px; margin-bottom: 6px">
                  <input v-model="m.claim" placeholder="claim path (e.g. department)" style="flex: 1" />
                  <select v-model="m.op" style="width: 110px">
                    <option value="exact">exact</option>
                    <option value="contains">contains</option>
                  </select>
                  <button @click="form.match.splice(i, 1)">✕</button>
                </div>
                <div v-for="(v, j) in m.values" :key="j" style="display: flex; gap: 6px; margin-bottom: 6px">
                  <input v-model="m.values[j]" placeholder="value" style="flex: 1" />
                  <button @click="m.values.splice(j, 1)">✕</button>
                </div>
                <button @click="m.values.push('')">+ value</button>
              </div>
              <button @click="form.match.push({ claim: '', op: 'exact', values: [''] })">+ match</button>
            </div>
          </div>
          <div class="form-row">
            <label>resolve.api_key *</label>
            <select v-model="form.resolve_api_key">
              <option value="">{{ t('resources.chooseKey') }}</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>
      </template>

      <template v-else>
        <RawYamlEditor v-model="rawText" />
      </template>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
        <button @click="editing = null">{{ t('common.cancel') }}</button>
        <button class="primary" :disabled="saving" @click="tab === 'form' ? save() : saveRaw()">
          {{ saving ? t('common.saving') : t('common.saveAndReload') }}
        </button>
      </div>
      <div v-if="lastResult && lastResult.ok" class="badge ok" style="margin-top: 10px">
        {{ t('common.saved') }}{{ lastResult.reload?.warning ? t('common.sep') + t('save.reloadWarning') : '' }}
      </div>
    </Modal>
  </div>
</template>
