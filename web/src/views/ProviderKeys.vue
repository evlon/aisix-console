<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import ResourceFacts from '../components/ResourceFacts.vue';

const { t, te } = useI18n();

// Field labels and help come from the catalogue copy, the same chain the resource
// catalogue uses: per-kind override, then shared field.*, then the column label.
// The seven JSON boxes below used to be labelled with their configuration keys.
const FL = (kind, field) => {
  const keys = [
    `resourceCatalog.kind.${kind}.field.${field}`,
    `resourceCatalog.field.${field}`,
    `resourceCatalog.col.${field}`,
  ];
  for (const key of keys) if (te(key)) return t(key);
  return field;
};

const FH = (kind, field) => {
  for (const key of [`resourceCatalog.kind.${kind}.fieldHelp.${field}`, `resourceCatalog.fieldHelp.${field}`]) {
    if (te(key)) return t(key);
  }
  return '';
};
const entries = ref([]);
const loading = ref(false);
const editing = ref(null); // null = hidden, {} = create, object = edit
const saving = ref(false);
const lastResult = ref(null);

const emptyForm = () => ({
  display_name: '',
  provider: 'openai',
  api_base: '',
  adapter: '',
  api_key: '', // value (if storing to console) or `${VAR}` literal
  keyMode: 'console', // 'console' | 'envref'
  // Advanced fields (aisix >=1.1.0) surfaced as JSON text boxes so editing
  // never drops them; empty means "omit".
  apis_text: '',
  request_text: '',
  response_text: '',
  tls_text: '',
  resolve_addresses_text: '',
  strip_headers_text: '',
  telemetry_tags_text: '',
});

function parseJsonObj(text, label) {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

const form = ref(emptyForm());

async function load() {
  loading.value = true;
  try {
    const r = await api.list('provider_keys');
    entries.value = r.entries ?? [];
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = emptyForm();
  editing.value = {};
  lastResult.value = null;
}

function openEdit(e) {
  form.value = {
    display_name: e.display_name ?? '',
    provider: e.provider ?? '',
    api_base: e.api_base ?? '',
    adapter: e.adapter ?? '',
    api_key: '',
    keyMode: /^\$\{[A-Z0-9_]+\}$/.test(e.api_key ?? '') ? 'envref' : 'console',
    envRef: /^\$\{([A-Z0-9_]+)\}$/.exec(e.api_key ?? '')?.[1] || '',
    apis_text: e.apis ? JSON.stringify(e.apis, null, 2) : '',
    request_text: e.request ? JSON.stringify(e.request, null, 2) : '',
    response_text: e.response ? JSON.stringify(e.response, null, 2) : '',
    tls_text: e.tls ? JSON.stringify(e.tls, null, 2) : '',
    resolve_addresses_text: e.resolve_addresses ? JSON.stringify(e.resolve_addresses, null, 2) : '',
    strip_headers_text: e.strip_headers ? JSON.stringify(e.strip_headers, null, 2) : '',
    telemetry_tags_text: e.telemetry_tags ? JSON.stringify(e.telemetry_tags, null, 2) : '',
  };
  editing.value = e;
  lastResult.value = null;
}

async function save() {
  if (!form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: t('common.required') }] };
    return;
  }
  saving.value = true;
  try {
    const entry = {
      display_name: form.value.display_name,
      provider: form.value.provider || undefined,
      api_base: form.value.api_base || undefined,
      adapter: form.value.adapter || undefined,
    };

    if (form.value.keyMode === 'envref') {
      const varName = form.value.envRef || `EXISTING_VAR`;
      entry.api_key = `\${${varName}}`;
    } else if (form.value.api_key) {
      // Plaintext: written directly into resources.yaml so the gateway picks
      // it up on the next hot reload — no container recreate, no env wiring.
      entry.api_key = form.value.api_key;
    } else if (editing.value?.api_key) {
      entry.api_key = editing.value.api_key; // keep existing (masked / env ref)
    } else {
      lastResult.value = { ok: false, errors: [{ message: t('providerKeys.apiKey') + ' *' }] };
      return;
    }

    // Advanced fields: parse each JSON text box and attach when non-empty.
    try {
      const apis = parseJsonObj(form.value.apis_text, 'apis');
      if (apis !== undefined) entry.apis = apis;
      const req = parseJsonObj(form.value.request_text, 'request');
      if (req !== undefined) entry.request = req;
      const resp = parseJsonObj(form.value.response_text, 'response');
      if (resp !== undefined) entry.response = resp;
      const tls = parseJsonObj(form.value.tls_text, 'tls');
      if (tls !== undefined) entry.tls = tls;
      const addrs = parseJsonObj(form.value.resolve_addresses_text, 'resolve_addresses');
      if (addrs !== undefined) entry.resolve_addresses = addrs;
      const sh = parseJsonObj(form.value.strip_headers_text, 'strip_headers');
      if (sh !== undefined) entry.strip_headers = sh;
      const tags = parseJsonObj(form.value.telemetry_tags_text, 'telemetry_tags');
      if (tags !== undefined) entry.telemetry_tags = tags;
    } catch (e) {
      lastResult.value = { ok: false, errors: [{ message: e.message }] };
      return;
    }

    const isEdit = !!editing.value?.display_name && entries.value.some((x) => x.display_name === editing.value.display_name);
    const result = isEdit
      ? await api.update('provider_keys', editing.value.display_name, entry)
      : await api.create('provider_keys', entry);
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
  if (!confirm(t('providerKeys.deleteConfirm', { name: e.display_name }))) return;
  try {
    const r = await api.remove('provider_keys', e.display_name);
    lastResult.value = r;
    if (r.ok) await load();
  } catch (err) {
    lastResult.value = { ok: false, errors: [{ message: err.message }] };
  }
}

function maskKey(k) {
  if (/^\$\{/.test(k || '')) return k;
  return k ? t('providerKeys.keySet') : t('providerKeys.keyUnset');
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="lastResult && !lastResult.ok" class="error-box">
      <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
    </div>

    <!-- The same six questions every resource answers, from the same copy the
         catalogue uses. All three own-page kinds carry one, so the pages a user
         is most likely to land on first do not differ in shape. -->
    <ResourceFacts kind="provider_keys" />

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <h3 style="margin: 0">{{ t('providerKeys.title') }}</h3>
        <button class="primary" @click="openCreate">+ {{ t('common.add') }}</button>
      </div>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>{{ t('providerKeys.colName') }}</th><th>{{ t('providerKeys.colProvider') }}</th><th>{{ t('providerKeys.colAdapter') }}</th><th>{{ t('providerKeys.colApiBase') }}</th><th>{{ t('providerKeys.colApiKey') }}</th><th>{{ t('common.actions') }}</th></tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td colspan="6" class="muted">{{ t('providerKeys.empty') }}</td>
          </tr>
          <tr v-for="e in entries" :key="e.display_name">
            <td>{{ e.display_name }}</td>
            <td>{{ e.provider || '—' }}</td>
            <td>{{ e.adapter || '—' }}</td>
            <td class="muted">{{ e.api_base || '—' }}</td>
            <td>{{ maskKey(e.api_key) }}</td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">{{ t('common.edit') }}</button>
              <button class="danger" @click="remove(e)">{{ t('common.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="editing.display_name ? t('providerKeys.edit', { name: editing.display_name }) : t('providerKeys.add')" @close="editing = null">
      <div class="form-row">
        <label>{{ t('providerKeys.colName') }} *</label>
        <input v-model="form.display_name" placeholder="openai-main" />
      </div>
      <div class="form-row">
        <label>{{ t('providerKeys.provider') }}</label>
        <input v-model="form.provider" placeholder="openai / deepseek / ..." />
      </div>
      <div class="form-row">
        <label>{{ t('providerKeys.colAdapter') }}</label>
        <select v-model="form.adapter">
          <option value="">{{ t('providerKeys.adapterAuto') }}</option>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="bedrock">bedrock</option>
          <option value="vertex">vertex</option>
          <option value="azure-openai">azure-openai</option>
        </select>
      </div>
      <div class="form-row">
        <label>{{ t('providerKeys.colApiBase') }}</label>
        <input v-model="form.api_base" :placeholder="t('providerKeys.apiBasePlaceholder')" />
      </div>
      <div class="form-row">
        <label>{{ t('providerKeys.apiKey') }}</label>
        <div>
          <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px">
            <input type="radio" v-model="form.keyMode" value="console" />
            {{ t('providerKeys.keyModeConsole') }}
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="radio" v-model="form.keyMode" value="envref" />
            {{ t('providerKeys.keyModeEnv') }}
          </label>
          <input
            v-if="form.keyMode === 'console'"
            v-model="form.api_key"
            type="password"
            :placeholder="editing.display_name ? t('providerKeys.keepExisting') : t('providerKeys.keyPlaceholder')"
            style="width: 100%; margin-top: 6px"
          />
          <input
            v-else
            v-model="form.envRef"
            :placeholder="t('providerKeys.envVarPlaceholder')"
            style="width: 100%; margin-top: 6px"
          />
        </div>
      </div>
      <details style="margin-top: 12px">
        <summary>{{ t('providerKeys.advanced') }}</summary>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'apis') }}</label>
          <textarea v-model="form.apis_text" rows="3" style="flex: 1" placeholder='{"messages": {"base": "…/anthropic"}}' />
          <p v-if="FH('provider_keys', 'apis')" class="fh">{{ FH('provider_keys', 'apis') }}</p>
        </div>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'request') }}</label>
          <textarea v-model="form.request_text" rows="3" style="flex: 1" placeholder='{"param_renames": {"max_tokens": "max_completion_tokens"}}' />
          <p v-if="FH('provider_keys', 'request')" class="fh">{{ FH('provider_keys', 'request') }}</p>
        </div>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'response') }}</label>
          <textarea v-model="form.response_text" rows="2" style="flex: 1" placeholder='{"reasoning_field": "delta.reasoning_content"}' />
          <p v-if="FH('provider_keys', 'response')" class="fh">{{ FH('provider_keys', 'response') }}</p>
        </div>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'tls') }}</label>
          <textarea v-model="form.tls_text" rows="2" style="flex: 1" placeholder='{"ca_cert": "-----BEGIN…", "verify": true}' />
          <p v-if="FH('provider_keys', 'tls')" class="fh">{{ FH('provider_keys', 'tls') }}</p>
        </div>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'resolve_addresses') }}</label>
          <textarea v-model="form.resolve_addresses_text" rows="2" style="flex: 1" placeholder='["10.0.0.5"]' />
          <p v-if="FH('provider_keys', 'resolve_addresses')" class="fh">{{ FH('provider_keys', 'resolve_addresses') }}</p>
        </div>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'strip_headers') }}</label>
          <textarea v-model="form.strip_headers_text" rows="2" style="flex: 1" placeholder='["authorization","cookie"]' />
          <p v-if="FH('provider_keys', 'strip_headers')" class="fh">{{ FH('provider_keys', 'strip_headers') }}</p>
        </div>
        <div class="form-row">
          <label>{{ FL('provider_keys', 'telemetry_tags') }}</label>
          <textarea v-model="form.telemetry_tags_text" rows="2" style="flex: 1" placeholder='{"kind": "byo", "pk_label": "prod"}' />
          <p v-if="FH('provider_keys', 'telemetry_tags')" class="fh">{{ FH('provider_keys', 'telemetry_tags') }}</p>
        </div>
      </details>
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
        <button @click="editing = null">{{ t('common.cancel') }}</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.saveAndReload') }}</button>
      </div>
      <div v-if="lastResult && lastResult.ok" class="badge ok" style="margin-top: 10px">
        {{ t('common.saved') }}{{ lastResult.reload?.warning ? t('common.sep') + lastResult.reload.warning : '' }}{{ lastResult.notice ? t('common.sep') + lastResult.notice : '' }}
      </div>
    </Modal>
  </div>
</template>

<style scoped>
/* The label column holds Chinese field names and the help sits under the input
   spanning both columns: a 40-character sentence in the label column would wrap
   to four lines and bury the input. */
.modal .form-row {
  grid-template-columns: 200px 1fr;
}

.modal .form-row > .fh {
  grid-column: 2;
  margin: -2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}
</style>