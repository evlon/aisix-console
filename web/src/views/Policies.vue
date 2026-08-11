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

function emptyEntry() {
  if (activeKind.value === 'rate_limit_policies') {
    return { name: '', scope: 'api_key', scope_ref: '', window: 'minute', max_requests: '', max_tokens: '' };
  }
  if (activeKind.value === 'cache_policies') {
    return { name: '', enabled: true, backend: 'memory', ttl_seconds: 3600, applies_to: 'all', scope: 'api_key', purge_generation: 0 };
  }
  return { name: '', enabled: true, hook_point: 'input', fail_open: true, kind: 'keyword', patterns: [''] };
}

const form = ref(emptyEntry());

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
  if (activeKind.value === 'rate_limit_policies') {
    f.max_requests = e.max_requests ?? '';
    f.max_tokens = e.max_tokens ?? '';
  }
  if (activeKind.value === 'guardrails') {
    // flatten kind-specific config fields onto the form
    f.patterns = e.patterns ?? [''];
    f.pii_entities = e.pii_entities ?? [];
    f.api_base = e.api_base ?? '';
  }
  form.value = f;
  lastResult.value = null;
  tab.value = 'form';
  rawText.value = stringifyYaml(e, { lineWidth: 0 });
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
  // guardrail
  const out = {
    name: f.name,
    enabled: !!f.enabled,
    hook_point: f.hook_point,
    fail_open: !!f.fail_open,
    kind: f.kind,
  };
  if (f.kind === 'keyword') {
    out.patterns = (f.patterns || []).map((p) => p.trim()).filter(Boolean);
    if (!out.patterns.length) throw new Error(t('policies.grPatterns') + ' *');
  } else if (f.pii_entities) {
    out.pii_entities = f.pii_entities;
  }
  if (f.enforcement_mode) out.enforcement_mode = f.enforcement_mode;
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
              <option value="bedrock">{{ t('policies.bedrock') }}</option>
              <option value="aliyun_content_safety">{{ t('policies.aliyunContentSafety') }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('policies.grHook') }}</label>
            <select v-model="form.hook_point">
              <option value="input">{{ t('policies.grHookInput') }}</option>
              <option value="output">{{ t('policies.grHookOutput') }}</option>
            </select>
          </div>
          <div class="form-row" v-if="form.kind === 'keyword'">
            <label>{{ t('policies.grPatterns') }}</label>
            <div>
              <div v-for="(p, i) in form.patterns" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.patterns[i]" :placeholder="t('policies.grPatternPlaceholder')" style="flex: 1" />
                <button @click="form.patterns.splice(i, 1)">✕</button>
              </div>
              <button @click="form.patterns.push('')">+ {{ t('common.add') }}</button>
            </div>
          </div>
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
