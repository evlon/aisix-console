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
];

const IDENTITY = {
  mcp_servers: 'display_name',
  a2a_agents: 'display_name',
  oidc_providers: 'name',
  observability_exporters: 'name',
  claim_mappings: 'name',
};

const activeKind = ref(KINDS[0].key);
const entries = ref([]);
const apiKeys = ref([]);
const loading = ref(false);
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
      display_name: '', type: 'mcp', url: '', transport: 'streamable_http',
      auth_type: 'none', secret: '', client_id: '', token_url: '', scopes: [''],
      spec_text: '', api_key_header: '', timeout_ms: '', enabled: true,
    };
  }
  if (k === 'a2a_agents') {
    return {
      display_name: '', url: '', protocol_version: '1.0',
      auth_type: 'none', secret: '', timeout_ms: '', enabled: true,
    };
  }
  if (k === 'oidc_providers') {
    return {
      name: '', issuer: '', audiences: [''], jwks_uri: '', identity_claim: 'sub',
      required_scopes: [''], bound_claims_text: '{}', leeway_secs: 0, enabled: true,
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
  }
  if (k === 'a2a_agents') {
    if (!f.auth_type) f.auth_type = 'none';
  }
  if (k === 'oidc_providers') {
    f.audiences = e.audiences?.length ? e.audiences : [''];
    f.required_scopes = e.required_scopes?.length ? e.required_scopes : [''];
    f.bound_claims_text = e.bound_claims ? JSON.stringify(e.bound_claims, null, 2) : '{}';
    if (f.leeway_secs === undefined) f.leeway_secs = 0;
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
      display_name: f.display_name,
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
    return out;
  }

  if (k === 'a2a_agents') {
    return clean({
      display_name: f.display_name,
      url: f.url,
      protocol_version: f.protocol_version || '1.0',
      auth_type: f.auth_type || 'none',
      secret: f.auth_type !== 'none' ? f.secret : undefined,
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
    });
  }

  if (k === 'oidc_providers') {
    const audiences = (f.audiences || []).map((a) => a.trim()).filter(Boolean);
    if (!audiences.length) throw new Error('audiences');
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
    const [r, k] = await Promise.all([api.list(activeKind.value), api.list('api_keys')]);
    entries.value = r.entries ?? [];
    apiKeys.value = (k.entries ?? []).map((e) => e.display_name || e.key_hash?.slice(0, 8)).filter(Boolean);
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
  if (!form.value.name && !form.value.display_name) {
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
    const identity = original?.[IDENTITY[activeKind.value]] ?? '';
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
    const identity = original?.[IDENTITY[activeKind.value]] ?? '';
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
  const identity = e[IDENTITY[activeKind.value]];
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
  if (k === 'mcp_servers') return ['display_name', 'type', 'url', 'auth_type', 'enabled'];
  if (k === 'a2a_agents') return ['display_name', 'url', 'protocol_version', 'auth_type', 'enabled'];
  if (k === 'oidc_providers') return ['name', 'issuer', 'identity_claim', 'enabled'];
  if (k === 'observability_exporters') return ['name', 'kind', 'enabled'];
  return ['name', 'jwt_provider', 'priority', 'enabled'];
}

function cell(e, col) {
  if (col === 'enabled') return e.enabled ? t('common.enabled') : t('common.disabled');
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
            <label>display_name *</label>
            <input v-model="form.display_name" />
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
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- a2a agents -->
        <template v-else-if="activeKind === 'a2a_agents'">
          <div class="form-row">
            <label>display_name *</label>
            <input v-model="form.display_name" />
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

        <!-- claim mappings -->
        <template v-else>
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>jwt_provider *</label>
            <input v-model="form.jwt_provider" />
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
