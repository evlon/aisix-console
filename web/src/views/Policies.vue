<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import RawYamlEditor from '../components/RawYamlEditor.vue';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const { t } = useI18n();

const KINDS = [
  { key: 'rate_limit_policies', label: () => t('policies.rateLimit') },
  { key: 'cache_policies', label: () => t('policies.cache') },
  { key: 'guardrails', label: () => t('policies.guardrails') },
];

const activeKind = ref(KINDS[0].key);
const entries = ref([]);
const models = ref([]);
const apiKeys = ref([]);
const loading = ref(false);
const editing = ref(null); // { original, entry }
const saving = ref(false);
const lastResult = ref(null);
const tab = ref('form');
const rawText = ref('');

const kindOf = (key) => KINDS.find((k) => k.key === key);

// identity field per kind
const IDENTITY = { rate_limit_policies: 'name', cache_policies: 'name', guardrails: 'name' };

async function load() {
  loading.value = true;
  try {
    const [r, m, k] = await Promise.all([
      api.list(activeKind.value),
      api.list('models'),
      api.list('api_keys'),
    ]);
    entries.value = r.entries ?? [];
    models.value = (m.entries ?? []).map((e) => e.display_name).filter(Boolean);
    apiKeys.value = (k.entries ?? []).map((e) => e.display_name || e.key_hash.slice(0, 8)).filter(Boolean);
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

function emptyGuardrail(kind) {
  const base = {
    name: '',
    enabled: true,
    kind: kind || 'keyword',
    hook_point: 'both',
    enforcement_mode: 'block',
    fail_open: true,
    direction: 'both',
  };
  if (kind === 'keyword') base.patterns = [{ kind: 'literal', value: '' }];
  else if (kind === 'pii') {
    base.default_action = 'mask';
    base.detectors = [];
    base.custom_patterns = [];
    base.on_buffer_exceeded = 'fail_closed';
  } else if (kind === 'openai_moderation') {
    base.api_key = '';
    base.model = 'omni-moderation-latest';
    base.category_thresholds_text = '';
    base.timeout_ms = '';
    base.output_fail_open = false;
  } else if (kind === 'lakera') {
    base.api_key = '';
    base.endpoint = '';
    base.project_id = '';
    base.timeout_ms = '';
    base.output_fail_open = false;
    base.max_buffer_bytes = '';
    base.on_buffer_exceeded = 'fail_closed';
  } else if (kind === 'presidio') {
    base.analyzer_url = '';
    base.anonymizer_url = '';
    base.default_action = 'mask';
    base.entities = [];
    base.operator = 'replace';
    base.language = 'en';
    base.score_threshold = '';
    base.timeout_ms = '';
    base.output_fail_open = false;
    base.max_buffer_bytes = '';
    base.on_buffer_exceeded = 'fail_closed';
  } else if (kind === 'azure_content_safety') {
    base.api_key = '';
    base.endpoint = '';
    base.timeout_ms = '';
    base.output_fail_open = false;
  } else if (kind === 'azure_content_safety_text_moderation') {
    base.api_key = '';
    base.endpoint = '';
    base.categories = ['Hate', 'Sexual', 'SelfHarm', 'Violence'];
    base.blocklist_names_text = '';
    base.severity_threshold = 2;
    base.severity_threshold_by_category_text = '';
    base.output_type = 'FourSeverityLevels';
    base.stream_processing_mode = 'window';
    base.text_source = 'concatenate_user_content';
    base.halt_on_blocklist_hit = false;
    base.window_size = 10000;
    base.window_overlap_size = 256;
    base.max_buffer_bytes = '';
    base.on_buffer_exceeded = 'fail_closed';
    base.timeout_ms = '';
    base.output_fail_open = false;
  } else if (kind === 'bedrock') {
    base.aws_access_key_id = '';
    base.aws_secret_access_key = '';
    base.guardrail_id = '';
    base.guardrail_version = '';
    base.region = '';
    base.latency_mode = 'serial';
    base.latency_timeout_ms = '';
    base.output_fail_open = false;
  } else if (kind === 'aliyun_text_moderation') {
    base.access_key_id = '';
    base.access_key_secret = '';
    base.region = 'cn-shanghai';
    base.endpoint = '';
    base.risk_level_threshold = 'high';
    base.stream_processing_mode = 'window';
    base.window_size = 2000;
    base.window_overlap_size = 128;
    base.max_buffer_bytes = '';
    base.on_buffer_exceeded = 'fail_closed';
    base.timeout_ms = '';
    base.output_fail_open = false;
  } else if (kind === 'aliyun_ai_guardrail') {
    base.access_key_id = '';
    base.access_key_secret = '';
    base.region = 'cn-shanghai';
    base.endpoint = '';
    base.service_level = 'pro';
    base.stream_processing_mode = 'window';
    base.window_size = 2000;
    base.window_overlap_size = 128;
    base.max_buffer_bytes = '';
    base.on_buffer_exceeded = 'fail_closed';
    base.timeout_ms = '';
    base.output_fail_open = false;
  }
  return base;
}

function emptyEntry() {
  if (activeKind.value === 'rate_limit_policies') {
    return { name: '', scope: 'api_key', scope_ref: '', window: 'minute', max_requests: '', max_tokens: '' };
  }
  if (activeKind.value === 'cache_policies') {
    return { name: '', enabled: true, backend: 'memory', ttl_seconds: 3600, applies_to: 'all', scope: 'api_key', purge_generation: 0 };
  }
  return emptyGuardrail('keyword');
}

const form = ref(emptyEntry());

function openCreate() {
  form.value = emptyEntry();
  editing.value = { original: null };
  lastResult.value = null;
  tab.value = 'form';
  rawText.value = '';
}

// Flatten a guardrail entry's kind-specific config onto the editable form.
function flattenGuardrail(f, e) {
  f.hook_point = e.hook_point ?? 'both';
  f.enforcement_mode = e.enforcement_mode ?? 'block';
  f.fail_open = e.fail_open ?? true;
  f.direction = e.direction ?? 'both';
  if (e.created_at) f.created_at = e.created_at;
  const k = e.kind;
  if (k === 'keyword') {
    f.patterns = Array.isArray(e.patterns) && e.patterns.length
      ? e.patterns.map((p) => (typeof p === 'string' ? { kind: 'literal', value: p } : { kind: p.kind ?? 'literal', value: p.value ?? '' }))
      : [{ kind: 'literal', value: '' }];
  } else if (k === 'pii') {
    f.default_action = e.default_action ?? 'mask';
    f.detectors = Array.isArray(e.detectors) ? e.detectors.map((d) => ({ type: d.type ?? '', action: d.action ?? '' })) : [];
    f.custom_patterns = Array.isArray(e.custom_patterns) ? e.custom_patterns.map((p) => ({ name: p.name ?? '', regex: p.regex ?? '', action: p.action ?? '' })) : [];
    f.on_buffer_exceeded = e.on_buffer_exceeded ?? 'fail_closed';
    f.max_buffer_bytes = e.max_buffer_bytes ?? '';
  } else if (k === 'openai_moderation') {
    f.api_key = e.api_key ?? '';
    f.endpoint = e.endpoint ?? '';
    f.model = e.model ?? 'omni-moderation-latest';
    f.category_thresholds_text = e.category_thresholds ? JSON.stringify(e.category_thresholds, null, 2) : '';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
  } else if (k === 'lakera') {
    f.api_key = e.api_key ?? '';
    f.endpoint = e.endpoint ?? '';
    f.project_id = e.project_id ?? '';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
    f.max_buffer_bytes = e.max_buffer_bytes ?? '';
    f.on_buffer_exceeded = e.on_buffer_exceeded ?? 'fail_closed';
  } else if (k === 'presidio') {
    f.analyzer_url = e.analyzer_url ?? '';
    f.anonymizer_url = e.anonymizer_url ?? '';
    f.default_action = e.default_action ?? 'mask';
    f.entities = Array.isArray(e.entities) ? e.entities.map((en) => ({ type: en.type ?? '', action: en.action ?? '' })) : [];
    f.operator = e.operator ?? 'replace';
    f.language = e.language ?? 'en';
    f.score_threshold = e.score_threshold ?? '';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
    f.max_buffer_bytes = e.max_buffer_bytes ?? '';
    f.on_buffer_exceeded = e.on_buffer_exceeded ?? 'fail_closed';
  } else if (k === 'azure_content_safety') {
    f.api_key = e.api_key ?? '';
    f.endpoint = e.endpoint ?? '';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
  } else if (k === 'azure_content_safety_text_moderation') {
    f.api_key = e.api_key ?? '';
    f.endpoint = e.endpoint ?? '';
    f.categories = Array.isArray(e.categories) ? e.categories : ['Hate', 'Sexual', 'SelfHarm', 'Violence'];
    f.blocklist_names_text = JSON.stringify(e.blocklist_names ?? [], null, 2);
    f.severity_threshold = e.severity_threshold ?? 2;
    f.severity_threshold_by_category_text = e.severity_threshold_by_category ? JSON.stringify(e.severity_threshold_by_category, null, 2) : '';
    f.output_type = e.output_type ?? 'FourSeverityLevels';
    f.stream_processing_mode = e.stream_processing_mode ?? 'window';
    f.text_source = e.text_source ?? 'concatenate_user_content';
    f.halt_on_blocklist_hit = !!e.halt_on_blocklist_hit;
    f.window_size = e.window_size ?? 10000;
    f.window_overlap_size = e.window_overlap_size ?? 256;
    f.max_buffer_bytes = e.max_buffer_bytes ?? '';
    f.on_buffer_exceeded = e.on_buffer_exceeded ?? 'fail_closed';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
  } else if (k === 'bedrock') {
    f.aws_access_key_id = e.aws_credentials?.access_key_id ?? '';
    f.aws_secret_access_key = e.aws_credentials?.secret_access_key ?? '';
    f.guardrail_id = e.guardrail_id ?? '';
    f.guardrail_version = e.guardrail_version ?? '';
    f.region = e.region ?? '';
    f.latency_mode = e.latency_mode?.kind ?? 'serial';
    f.latency_timeout_ms = e.latency_mode?.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
  } else if (k === 'aliyun_text_moderation') {
    f.access_key_id = e.access_key_id ?? '';
    f.access_key_secret = e.access_key_secret ?? '';
    f.region = e.region ?? 'cn-shanghai';
    f.endpoint = e.endpoint ?? '';
    f.risk_level_threshold = e.risk_level_threshold ?? 'high';
    f.stream_processing_mode = e.stream_processing_mode ?? 'window';
    f.window_size = e.window_size ?? 2000;
    f.window_overlap_size = e.window_overlap_size ?? 128;
    f.max_buffer_bytes = e.max_buffer_bytes ?? '';
    f.on_buffer_exceeded = e.on_buffer_exceeded ?? 'fail_closed';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
  } else if (k === 'aliyun_ai_guardrail') {
    f.access_key_id = e.access_key_id ?? '';
    f.access_key_secret = e.access_key_secret ?? '';
    f.region = e.region ?? 'cn-shanghai';
    f.endpoint = e.endpoint ?? '';
    f.service_level = e.service_level ?? 'pro';
    f.stream_processing_mode = e.stream_processing_mode ?? 'window';
    f.window_size = e.window_size ?? 2000;
    f.window_overlap_size = e.window_overlap_size ?? 128;
    f.max_buffer_bytes = e.max_buffer_bytes ?? '';
    f.on_buffer_exceeded = e.on_buffer_exceeded ?? 'fail_closed';
    f.timeout_ms = e.timeout_ms ?? '';
    f.output_fail_open = !!e.output_fail_open;
  }
}

function openEdit(e) {
  editing.value = { original: e };
  const f = JSON.parse(JSON.stringify(e));
  if (activeKind.value === 'rate_limit_policies') {
    f.max_requests = e.max_requests ?? '';
    f.max_tokens = e.max_tokens ?? '';
  }
  if (activeKind.value === 'guardrails') {
    flattenGuardrail(f, e);
  }
  form.value = f;
  lastResult.value = null;
  tab.value = 'form';
  rawText.value = stringifyYaml(e, { lineWidth: 0 });
}

function parseJsonObj(text, label) {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

function buildEntry() {
  const f = JSON.parse(JSON.stringify(form.value));
  if (activeKind.value === 'rate_limit_policies') {
    const out = { name: f.name, scope: f.scope };
    out.scope_ref = f.scope_ref;
    out.window = f.window;
    if (f.max_requests !== '') out.max_requests = Number(f.max_requests);
    if (f.max_tokens !== '') out.max_tokens = Number(f.max_tokens);
    return out;
  }
  if (activeKind.value === 'cache_policies') {
    return {
      name: f.name,
      enabled: !!f.enabled,
      backend: f.backend,
      ttl_seconds: Number(f.ttl_seconds || 3600),
      applies_to: f.applies_to || 'all',
      scope: f.scope,
      purge_generation: Number(f.purge_generation || 0),
    };
  }
  // guardrail — common fields
  const out = {
    name: f.name,
    enabled: !!f.enabled,
    kind: f.kind,
    hook_point: f.hook_point,
    enforcement_mode: f.enforcement_mode,
    fail_open: !!f.fail_open,
    direction: f.direction,
  };
  if (f.created_at) out.created_at = f.created_at;
  const num = (v) => (v === '' || v === undefined || v === null ? undefined : Number(v));
  if (f.kind === 'keyword') {
    out.patterns = (f.patterns || []).map((p) => ({ kind: p.kind || 'literal', value: (p.value || '').trim() })).filter((p) => p.value);
    if (!out.patterns.length) throw new Error(t('policies.grPatterns') + ' *');
  } else if (f.kind === 'pii') {
    out.default_action = f.default_action;
    out.detectors = (f.detectors || []).filter((d) => d.type && d.type.trim()).map((d) => ({ type: d.type.trim(), ...(d.action ? { action: d.action } : {}) }));
    out.custom_patterns = (f.custom_patterns || []).filter((p) => p.name && p.name.trim() && p.regex && p.regex.trim()).map((p) => ({ name: p.name.trim(), regex: p.regex.trim(), ...(p.action ? { action: p.action } : {}) }));
    const obe = f.on_buffer_exceeded;
    if (obe) out.on_buffer_exceeded = obe;
    const mbb = num(f.max_buffer_bytes);
    if (mbb !== undefined) out.max_buffer_bytes = mbb;
  } else if (f.kind === 'openai_moderation') {
    out.api_key = f.api_key;
    if (f.endpoint) out.endpoint = f.endpoint;
    if (f.model) out.model = f.model;
    const ct = parseJsonObj(f.category_thresholds_text, 'category_thresholds');
    if (ct && Object.keys(ct).length) out.category_thresholds = ct;
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
  } else if (f.kind === 'lakera') {
    out.api_key = f.api_key;
    if (f.endpoint) out.endpoint = f.endpoint;
    if (f.project_id) out.project_id = f.project_id;
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
    const obe = f.on_buffer_exceeded;
    if (obe) out.on_buffer_exceeded = obe;
    const mbb = num(f.max_buffer_bytes);
    if (mbb !== undefined) out.max_buffer_bytes = mbb;
  } else if (f.kind === 'presidio') {
    out.analyzer_url = f.analyzer_url;
    out.anonymizer_url = f.anonymizer_url;
    out.default_action = f.default_action;
    out.entities = (f.entities || []).filter((en) => en.type && en.type.trim()).map((en) => ({ type: en.type.trim(), ...(en.action ? { action: en.action } : {}) }));
    out.operator = f.operator;
    out.language = f.language;
    const st = num(f.score_threshold);
    if (st !== undefined) out.score_threshold = st;
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
    const obe = f.on_buffer_exceeded;
    if (obe) out.on_buffer_exceeded = obe;
    const mbb = num(f.max_buffer_bytes);
    if (mbb !== undefined) out.max_buffer_bytes = mbb;
  } else if (f.kind === 'azure_content_safety') {
    out.api_key = f.api_key;
    out.endpoint = f.endpoint;
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
  } else if (f.kind === 'azure_content_safety_text_moderation') {
    out.api_key = f.api_key;
    out.endpoint = f.endpoint;
    out.categories = (f.categories || []).filter(Boolean);
    const bl = parseJsonObj(f.blocklist_names_text, 'blocklist_names');
    if (Array.isArray(bl)) out.blocklist_names = bl;
    out.severity_threshold = f.severity_threshold;
    const stc = parseJsonObj(f.severity_threshold_by_category_text, 'severity_threshold_by_category');
    if (stc && Object.keys(stc).length) out.severity_threshold_by_category = stc;
    out.output_type = f.output_type;
    out.stream_processing_mode = f.stream_processing_mode;
    out.text_source = f.text_source;
    out.halt_on_blocklist_hit = !!f.halt_on_blocklist_hit;
    out.window_size = Number(f.window_size || 10000);
    out.window_overlap_size = Number(f.window_overlap_size || 256);
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
    const obe = f.on_buffer_exceeded;
    if (obe) out.on_buffer_exceeded = obe;
    const mbb = num(f.max_buffer_bytes);
    if (mbb !== undefined) out.max_buffer_bytes = mbb;
  } else if (f.kind === 'bedrock') {
    out.aws_credentials = {
      kind: 'static',
      access_key_id: f.aws_access_key_id,
      secret_access_key: f.aws_secret_access_key,
    };
    out.guardrail_id = f.guardrail_id;
    out.guardrail_version = f.guardrail_version;
    out.region = f.region;
    if (f.latency_mode === 'timed') {
      const to = num(f.latency_timeout_ms);
      out.latency_mode = { kind: 'timed', timeout_ms: to !== undefined ? to : 1000 };
    } else {
      out.latency_mode = { kind: 'serial' };
    }
    out.output_fail_open = !!f.output_fail_open;
  } else if (f.kind === 'aliyun_text_moderation') {
    out.access_key_id = f.access_key_id;
    out.access_key_secret = f.access_key_secret;
    out.region = f.region;
    if (f.endpoint) out.endpoint = f.endpoint;
    out.risk_level_threshold = f.risk_level_threshold;
    out.stream_processing_mode = f.stream_processing_mode;
    out.window_size = Number(f.window_size || 2000);
    out.window_overlap_size = Number(f.window_overlap_size || 128);
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
    const obe = f.on_buffer_exceeded;
    if (obe) out.on_buffer_exceeded = obe;
    const mbb = num(f.max_buffer_bytes);
    if (mbb !== undefined) out.max_buffer_bytes = mbb;
  } else if (f.kind === 'aliyun_ai_guardrail') {
    out.access_key_id = f.access_key_id;
    out.access_key_secret = f.access_key_secret;
    out.region = f.region;
    if (f.endpoint) out.endpoint = f.endpoint;
    out.service_level = f.service_level;
    out.stream_processing_mode = f.stream_processing_mode;
    out.window_size = Number(f.window_size || 2000);
    out.window_overlap_size = Number(f.window_overlap_size || 128);
    const to = num(f.timeout_ms);
    if (to !== undefined) out.timeout_ms = to;
    out.output_fail_open = !!f.output_fail_open;
    const obe = f.on_buffer_exceeded;
    if (obe) out.on_buffer_exceeded = obe;
    const mbb = num(f.max_buffer_bytes);
    if (mbb !== undefined) out.max_buffer_bytes = mbb;
  }
  return out;
}

async function save() {
  if (!form.value.name) {
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
  if (activeKind.value === 'rate_limit_policies') return ['name', 'scope', 'scope_ref', 'window', 'limits'];
  if (activeKind.value === 'cache_policies') return ['name', 'backend', 'ttl', 'applies_to', 'scope'];
  return ['name', 'kind', 'hook_point', 'enabled'];
}

function cell(e, col) {
  if (col === 'limits') return `${e.max_requests ? e.max_requests + ' req' : ''}${e.max_tokens ? (e.max_requests ? ' / ' : '') + e.max_tokens + ' tok' : ''}`;
  if (col === 'ttl') return `${e.ttl_seconds}s`;
  if (col === 'enabled') return e.enabled ? t('common.enabled') : t('common.disabled');
  return e[col] ?? '—';
}

onMounted(load);
</script>

<template>
  <div>
    <div style="display: flex; gap: 8px; margin-bottom: 14px">
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
      <p class="muted" style="margin-bottom: 0">{{ t('policies.hint') }}</p>
      <table style="margin-top: 12px">
        <thead>
          <tr>
            <th v-for="c in tableCols()" :key="c">{{ c === 'name' ? t('common.name') : c === 'enabled' ? t('common.status') : c }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td :colspan="tableCols().length + 1" class="muted">{{ t('policies.empty') }}</td>
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

    <Modal v-if="editing !== null" :title="(editing.original ? t('policies.edit') : t('policies.add')) + ' — ' + kindOf(activeKind).label()" @close="editing = null">
      <div style="margin-bottom: 12px">
        <button :class="{ primary: tab === 'form' }" style="margin-right: 6px" @click="tab = 'form'">{{ t('policies.tabForm') }}</button>
        <button :class="{ primary: tab === 'raw' }" @click="tab = 'raw'">{{ t('policies.tabRaw') }}</button>
      </div>

      <template v-if="tab === 'form'">
        <!-- rate limit policy -->
        <template v-if="activeKind === 'rate_limit_policies'">
          <div class="form-row">
            <label>{{ t('policies.rlName') }} *</label>
            <input v-model="form.name" placeholder="key-rpm" />
          </div>
          <div class="form-row">
            <label>{{ t('policies.rlScope') }}</label>
            <select v-model="form.scope">
              <option value="api_key">api_key</option>
              <option value="model">model</option>
              <option value="team">team</option>
              <option value="member">member</option>
              <option value="team_member">team_member</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.rlScopeRef') }}</label>
            <select v-if="form.scope === 'api_key'" v-model="form.scope_ref">
              <option value="">{{ t('policies.choose') }}</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
            <select v-else-if="form.scope === 'model'" v-model="form.scope_ref">
              <option value="">{{ t('policies.choose') }}</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
            <input v-else v-model="form.scope_ref" placeholder="team/member ID" />
          </div>
          <div class="form-row">
            <label>{{ t('policies.rlWindow') }}</label>
            <select v-model="form.window">
              <option value="second">second</option>
              <option value="minute">minute</option>
              <option value="hour">hour</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.rlMax') }}</label>
            <div style="display: flex; gap: 6px">
              <input v-model="form.max_requests" type="number" :placeholder="t('policies.rlMaxRequests')" style="flex: 1" />
              <input v-model="form.max_tokens" type="number" :placeholder="t('policies.rlMaxTokens')" style="flex: 1" />
            </div>
          </div>
        </template>

        <!-- cache policy -->
        <template v-else-if="activeKind === 'cache_policies'">
          <div class="form-row">
            <label>{{ t('policies.cacheName') }} *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>{{ t('policies.cacheEnabled') }}</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
          <div class="form-row">
            <label>{{ t('policies.cacheBackend') }}</label>
            <select v-model="form.backend">
              <option value="memory">memory</option>
              <option value="redis">redis</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.cacheTtl') }}</label>
            <input v-model="form.ttl_seconds" type="number" />
          </div>
          <div class="form-row">
            <label>{{ t('policies.cacheAppliesTo') }}</label>
            <input v-model="form.applies_to" placeholder="all / model:xxx / api_key:xxx" />
          </div>
          <div class="form-row">
            <label>{{ t('policies.cacheScope') }}</label>
            <select v-model="form.scope">
              <option value="api_key">{{ t('policies.cacheScopeApiKey') }}</option>
              <option value="env">{{ t('policies.cacheScopeEnv') }}</option>
            </select>
          </div>
        </template>

        <!-- guardrail -->
        <template v-else>
          <div class="form-row">
            <label>{{ t('policies.grName') }} *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>{{ t('policies.grKind') }}</label>
            <select v-model="form.kind">
              <option value="keyword">{{ t('policies.keyword') }}</option>
              <option value="pii">{{ t('policies.pii') }}</option>
              <option value="openai_moderation">{{ t('policies.openaiModeration') }}</option>
              <option value="lakera">{{ t('policies.lakera') }}</option>
              <option value="presidio">{{ t('policies.presidio') }}</option>
              <option value="azure_content_safety">{{ t('policies.azureContentSafety') }}</option>
              <option value="azure_content_safety_text_moderation">{{ t('policies.azureContentSafetyTm') }}</option>
              <option value="bedrock">{{ t('policies.bedrock') }}</option>
              <option value="aliyun_text_moderation">{{ t('policies.aliyunTextModeration') }}</option>
              <option value="aliyun_ai_guardrail">{{ t('policies.aliyunAiGuardrail') }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.grHook') }}</label>
            <select v-model="form.hook_point">
              <option value="input">{{ t('policies.grHookInput') }}</option>
              <option value="output">{{ t('policies.grHookOutput') }}</option>
              <option value="both">{{ t('policies.grHookBoth') }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.grEnforcement') }}</label>
            <select v-model="form.enforcement_mode">
              <option value="block">{{ t('policies.grEnforceBlock') }}</option>
              <option value="monitor">{{ t('policies.grEnforceMonitor') }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.grDirection') }}</label>
            <select v-model="form.direction">
              <option value="both">{{ t('policies.grDirBoth') }}</option>
              <option value="input">{{ t('policies.grDirInput') }}</option>
              <option value="output">{{ t('policies.grDirOutput') }}</option>
            </select>
          </div>
          <!-- keyword -->
          <template v-if="form.kind === 'keyword'">
            <div class="form-row">
              <label>{{ t('policies.grPatterns') }}</label>
              <div style="flex: 1">
                <div v-for="(p, i) in form.patterns" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                  <select v-model="p.kind" style="width: 110px">
                    <option value="literal">literal</option>
                    <option value="regex">regex</option>
                  </select>
                  <input v-model="p.value" :placeholder="t('policies.grPatternPlaceholder')" style="flex: 1" />
                  <button @click="form.patterns.splice(i, 1)">✕</button>
                </div>
                <button @click="form.patterns.push({ kind: 'literal', value: '' })">+ {{ t('common.add') }}</button>
              </div>
            </div>
          </template>

          <!-- pii -->
          <template v-else-if="form.kind === 'pii'">
            <div class="form-row">
              <label>{{ t('policies.grPiiDefaultAction') }}</label>
              <select v-model="form.default_action">
                <option value="mask">mask</option>
                <option value="block">block</option>
              </select>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grPiiDetectors') }}</label>
              <div style="flex: 1">
                <div v-for="(d, i) in form.detectors" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                  <select v-model="d.type" style="flex: 1">
                    <option value="">—</option>
                    <option value="email">email</option>
                    <option value="china_mobile">china_mobile</option>
                    <option value="china_id_card">china_id_card</option>
                    <option value="bank_card">bank_card</option>
                    <option value="us_ssn">us_ssn</option>
                    <option value="ip_address">ip_address</option>
                    <option value="api_key">api_key</option>
                    <option value="jwt">jwt</option>
                    <option value="private_key">private_key</option>
                  </select>
                  <select v-model="d.action" style="width: 110px">
                    <option value="">默认</option>
                    <option value="mask">mask</option>
                    <option value="block">block</option>
                  </select>
                  <button @click="form.detectors.splice(i, 1)">✕</button>
                </div>
                <button @click="form.detectors.push({ type: '', action: '' })">+ {{ t('common.add') }}</button>
              </div>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grPiiCustomPatterns') }}</label>
              <div style="flex: 1">
                <div v-for="(p, i) in form.custom_patterns" :key="i" style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 8px">
                  <div style="display: flex; gap: 6px; margin-bottom: 6px">
                    <input v-model="p.name" placeholder="name" style="flex: 1" />
                    <select v-model="p.action" style="width: 110px">
                      <option value="">默认</option>
                      <option value="mask">mask</option>
                      <option value="block">block</option>
                    </select>
                    <button @click="form.custom_patterns.splice(i, 1)">✕</button>
                  </div>
                  <input v-model="p.regex" placeholder="regex" style="width: 100%" />
                </div>
                <button @click="form.custom_patterns.push({ name: '', regex: '', action: '' })">+ {{ t('common.add') }}</button>
              </div>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grBufferExceeded') }}</label>
              <select v-model="form.on_buffer_exceeded">
                <option value="fail_closed">fail_closed</option>
                <option value="fail_open">fail_open</option>
              </select>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grMaxBufferBytes') }}</label>
              <input v-model="form.max_buffer_bytes" type="number" />
            </div>
          </template>

          <!-- openai_moderation -->
          <template v-else-if="form.kind === 'openai_moderation'">
            <div class="form-row">
              <label>api_key *</label>
              <input v-model="form.api_key" type="password" placeholder="sk-..." />
            </div>
            <div class="form-row">
              <label>endpoint</label>
              <input v-model="form.endpoint" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="form-row">
              <label>model</label>
              <input v-model="form.model" />
            </div>
            <div class="form-row">
              <label>category_thresholds (JSON)</label>
              <textarea v-model="form.category_thresholds_text" rows="3" style="flex: 1" placeholder='{"violence": 0.5}' />
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
          </template>

          <!-- lakera -->
          <template v-else-if="form.kind === 'lakera'">
            <div class="form-row">
              <label>api_key *</label>
              <input v-model="form.api_key" type="password" placeholder="sk-..." />
            </div>
            <div class="form-row">
              <label>endpoint</label>
              <input v-model="form.endpoint" placeholder="https://api.lakera.ai" />
            </div>
            <div class="form-row">
              <label>project_id</label>
              <input v-model="form.project_id" placeholder="project-..." />
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grMaxBufferBytes') }}</label>
              <input v-model="form.max_buffer_bytes" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grBufferExceeded') }}</label>
              <select v-model="form.on_buffer_exceeded">
                <option value="fail_closed">fail_closed</option>
                <option value="fail_open">fail_open</option>
              </select>
            </div>
          </template>

          <!-- presidio -->
          <template v-else-if="form.kind === 'presidio'">
            <div class="form-row">
              <label>analyzer_url *</label>
              <input v-model="form.analyzer_url" placeholder="http://presidio-analyzer:3000" />
            </div>
            <div class="form-row">
              <label>anonymizer_url *</label>
              <input v-model="form.anonymizer_url" placeholder="http://presidio-anonymizer:3000" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grPiiDefaultAction') }}</label>
              <select v-model="form.default_action">
                <option value="mask">mask</option>
                <option value="block">block</option>
              </select>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grPresidioEntities') }}</label>
              <div style="flex: 1">
                <div v-for="(en, i) in form.entities" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                  <input v-model="en.type" placeholder="PERSON / EMAIL_ADDRESS" style="flex: 1" />
                  <select v-model="en.action" style="width: 110px">
                    <option value="">默认</option>
                    <option value="mask">mask</option>
                    <option value="block">block</option>
                  </select>
                  <button @click="form.entities.splice(i, 1)">✕</button>
                </div>
                <button @click="form.entities.push({ type: '', action: '' })">+ {{ t('common.add') }}</button>
              </div>
            </div>
            <div class="form-row">
              <label>operator</label>
              <select v-model="form.operator">
                <option value="replace">replace</option>
                <option value="mask">mask</option>
                <option value="hash">hash</option>
                <option value="redact">redact</option>
              </select>
            </div>
            <div class="form-row">
              <label>language</label>
              <input v-model="form.language" placeholder="en" />
            </div>
            <div class="form-row">
              <label>score_threshold</label>
              <input v-model="form.score_threshold" type="number" step="0.01" min="0" max="1" />
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
            <div class="form-row">
              <label>{{ t('policies.grMaxBufferBytes') }}</label>
              <input v-model="form.max_buffer_bytes" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grBufferExceeded') }}</label>
              <select v-model="form.on_buffer_exceeded">
                <option value="fail_closed">fail_closed</option>
                <option value="fail_open">fail_open</option>
              </select>
            </div>
          </template>

          <!-- azure_content_safety (Prompt Shield) -->
          <template v-else-if="form.kind === 'azure_content_safety'">
            <div class="form-row">
              <label>api_key *</label>
              <input v-model="form.api_key" type="password" placeholder="Ocp-Apim-Subscription-Key" />
            </div>
            <div class="form-row">
              <label>endpoint *</label>
              <input v-model="form.endpoint" placeholder="https://my-resource.cognitiveservices.azure.com" />
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
          </template>

          <!-- azure_content_safety_text_moderation -->
          <template v-else-if="form.kind === 'azure_content_safety_text_moderation'">
            <div class="form-row">
              <label>api_key *</label>
              <input v-model="form.api_key" type="password" placeholder="Ocp-Apim-Subscription-Key" />
            </div>
            <div class="form-row">
              <label>endpoint *</label>
              <input v-model="form.endpoint" placeholder="https://my-resource.cognitiveservices.azure.com" />
            </div>
            <div class="form-row">
              <label>categories</label>
              <div style="flex: 1">
                <label v-for="c in ['Hate','Sexual','SelfHarm','Violence']" :key="c" style="margin-right: 12px">
                  <input type="checkbox" :value="c" v-model="form.categories" /> {{ c }}
                </label>
              </div>
            </div>
            <div class="form-row">
              <label>blocklist_names (JSON)</label>
              <textarea v-model="form.blocklist_names_text" rows="2" style="flex: 1" placeholder='["blocklist-a"]' />
            </div>
            <div class="form-row">
              <label>severity_threshold</label>
              <input v-model="form.severity_threshold" type="number" min="0" max="7" />
            </div>
            <div class="form-row">
              <label>severity_threshold_by_category (JSON)</label>
              <textarea v-model="form.severity_threshold_by_category_text" rows="2" style="flex: 1" placeholder='{"Hate": 3}' />
            </div>
            <div class="form-row">
              <label>output_type</label>
              <select v-model="form.output_type">
                <option value="FourSeverityLevels">FourSeverityLevels</option>
                <option value="EightSeverityLevels">EightSeverityLevels</option>
              </select>
            </div>
            <div class="form-row">
              <label>stream_processing_mode</label>
              <select v-model="form.stream_processing_mode">
                <option value="window">window</option>
                <option value="buffer_full">buffer_full</option>
              </select>
            </div>
            <div class="form-row">
              <label>text_source</label>
              <select v-model="form.text_source">
                <option value="concatenate_user_content">concatenate_user_content</option>
                <option value="concatenate_all_content">concatenate_all_content</option>
              </select>
            </div>
            <div class="form-row">
              <label>halt_on_blocklist_hit</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.halt_on_blocklist_hit" /></label>
            </div>
            <div class="form-row">
              <label>window_size</label>
              <input v-model="form.window_size" type="number" />
            </div>
            <div class="form-row">
              <label>window_overlap_size</label>
              <input v-model="form.window_overlap_size" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grMaxBufferBytes') }}</label>
              <input v-model="form.max_buffer_bytes" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grBufferExceeded') }}</label>
              <select v-model="form.on_buffer_exceeded">
                <option value="fail_closed">fail_closed</option>
                <option value="fail_open">fail_open</option>
              </select>
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
          </template>

          <!-- bedrock -->
          <template v-else-if="form.kind === 'bedrock'">
            <div class="form-row">
              <label>access_key_id *</label>
              <input v-model="form.aws_access_key_id" />
            </div>
            <div class="form-row">
              <label>secret_access_key *</label>
              <input v-model="form.aws_secret_access_key" type="password" />
            </div>
            <div class="form-row">
              <label>guardrail_id *</label>
              <input v-model="form.guardrail_id" />
            </div>
            <div class="form-row">
              <label>guardrail_version *</label>
              <input v-model="form.guardrail_version" placeholder="DRAFT / 1" />
            </div>
            <div class="form-row">
              <label>region *</label>
              <input v-model="form.region" placeholder="us-east-1" />
            </div>
            <div class="form-row">
              <label>latency_mode</label>
              <select v-model="form.latency_mode">
                <option value="serial">serial</option>
                <option value="timed">timed</option>
              </select>
            </div>
            <div class="form-row" v-if="form.latency_mode === 'timed'">
              <label>latency timeout_ms</label>
              <input v-model="form.latency_timeout_ms" type="number" min="100" max="5000" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
          </template>

          <!-- aliyun_text_moderation -->
          <template v-else-if="form.kind === 'aliyun_text_moderation'">
            <div class="form-row">
              <label>access_key_id *</label>
              <input v-model="form.access_key_id" />
            </div>
            <div class="form-row">
              <label>access_key_secret *</label>
              <input v-model="form.access_key_secret" type="password" />
            </div>
            <div class="form-row">
              <label>region *</label>
              <input v-model="form.region" placeholder="cn-shanghai" />
            </div>
            <div class="form-row">
              <label>endpoint</label>
              <input v-model="form.endpoint" />
            </div>
            <div class="form-row">
              <label>risk_level_threshold</label>
              <select v-model="form.risk_level_threshold">
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
            <div class="form-row">
              <label>stream_processing_mode</label>
              <select v-model="form.stream_processing_mode">
                <option value="window">window</option>
                <option value="buffer_full">buffer_full</option>
              </select>
            </div>
            <div class="form-row">
              <label>window_size</label>
              <input v-model="form.window_size" type="number" />
            </div>
            <div class="form-row">
              <label>window_overlap_size</label>
              <input v-model="form.window_overlap_size" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grMaxBufferBytes') }}</label>
              <input v-model="form.max_buffer_bytes" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grBufferExceeded') }}</label>
              <select v-model="form.on_buffer_exceeded">
                <option value="fail_closed">fail_closed</option>
                <option value="fail_open">fail_open</option>
              </select>
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
          </template>

          <!-- aliyun_ai_guardrail -->
          <template v-else-if="form.kind === 'aliyun_ai_guardrail'">
            <div class="form-row">
              <label>access_key_id *</label>
              <input v-model="form.access_key_id" />
            </div>
            <div class="form-row">
              <label>access_key_secret *</label>
              <input v-model="form.access_key_secret" type="password" />
            </div>
            <div class="form-row">
              <label>region *</label>
              <input v-model="form.region" placeholder="cn-shanghai" />
            </div>
            <div class="form-row">
              <label>endpoint</label>
              <input v-model="form.endpoint" />
            </div>
            <div class="form-row">
              <label>service_level</label>
              <select v-model="form.service_level">
                <option value="pro">pro</option>
                <option value="basic">basic</option>
              </select>
            </div>
            <div class="form-row">
              <label>stream_processing_mode</label>
              <select v-model="form.stream_processing_mode">
                <option value="window">window</option>
                <option value="buffer_full">buffer_full</option>
              </select>
            </div>
            <div class="form-row">
              <label>window_size</label>
              <input v-model="form.window_size" type="number" />
            </div>
            <div class="form-row">
              <label>window_overlap_size</label>
              <input v-model="form.window_overlap_size" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grMaxBufferBytes') }}</label>
              <input v-model="form.max_buffer_bytes" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grBufferExceeded') }}</label>
              <select v-model="form.on_buffer_exceeded">
                <option value="fail_closed">fail_closed</option>
                <option value="fail_open">fail_open</option>
              </select>
            </div>
            <div class="form-row">
              <label>timeout_ms</label>
              <input v-model="form.timeout_ms" type="number" />
            </div>
            <div class="form-row">
              <label>{{ t('policies.grOutputFailOpen') }}</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.output_fail_open" /></label>
            </div>
          </template>

          <div class="form-row">
            <label>{{ t('policies.grEnabled') }}</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
          <div class="form-row">
            <label>{{ t('policies.grFailOpen') }}</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.fail_open" /></label>
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
