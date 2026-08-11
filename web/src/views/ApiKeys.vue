<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import { generateCallerKey } from '../lib/keygen.js';
import { sha256Hex } from '../lib/sha256.js';

const { t } = useI18n();
const entries = ref([]);
const models = ref([]);
const loading = ref(false);
const editing = ref(null);
const saving = ref(false);
const lastResult = ref(null);
const generatedPlaintext = ref('');

const form = ref({
  display_name: '',
  mode: 'generate', // 'generate' | 'import' | 'envref'
  importPlaintext: '',
  envRef: '',
  allowed_models: ['*'],
  expires_at: '',
  disabled: false,
  rate_rpm: '',
});

async function load() {
  loading.value = true;
  try {
    const [k, m] = await Promise.all([api.list('api_keys'), api.list('models')]);
    entries.value = k.entries ?? [];
    models.value = (m.entries ?? []).map((e) => e.display_name).filter(Boolean);
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { display_name: '', mode: 'generate', importPlaintext: '', envRef: '', allowed_models: ['*'], expires_at: '', disabled: false, rate_rpm: '' };
  editing.value = {};
  lastResult.value = null;
  generatedPlaintext.value = '';
}

function openEdit(e) {
  form.value = {
    display_name: e.display_name ?? '',
    mode: 'generate',
    importPlaintext: '',
    envRef: '',
    allowed_models: [...(e.allowed_models ?? [])],
    expires_at: e.expires_at ?? '',
    disabled: !!e.disabled,
    rate_rpm: e.rate_limit?.rpm ?? '',
  };
  editing.value = e;
  lastResult.value = null;
}

function addAllowedModel() {
  form.value.allowed_models.push('');
}
function removeAllowedModel(i) {
  form.value.allowed_models.splice(i, 1);
}

async function save() {
  if (!form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: t('common.required') }] };
    return;
  }
  const entry = {
    display_name: form.value.display_name,
    allowed_models: form.value.allowed_models.map((m) => m.trim()).filter(Boolean),
  };
  if (form.value.rate_rpm !== '') entry.rate_limit = { rpm: Number(form.value.rate_rpm) };
  if (form.value.expires_at) entry.expires_at = new Date(form.value.expires_at).toISOString();
  if (form.value.disabled) entry.disabled = true;

  const isEdit = !!editing.value?.display_name;
  if (isEdit) {
    // editing an existing key: key_hash is immutable — keep it
    entry.key_hash = editing.value.key_hash;
    if (editing.value.key_env) entry.key_env = editing.value.key_env;
  } else if (form.value.mode === 'generate' || form.value.mode === 'import') {
    let plaintext;
    if (form.value.mode === 'generate') {
      plaintext = generateCallerKey();
    } else {
      plaintext = form.value.importPlaintext.trim();
      if (!plaintext) {
        lastResult.value = { ok: false, errors: [{ message: t('apiKeys.noPlaintext') }] };
        return;
      }
    }
    entry.key_hash = await sha256Hex(plaintext);
    generatedPlaintext.value = plaintext; // shown once in the modal
  } else if (form.value.mode === 'envref') {
    if (!form.value.envRef) {
      lastResult.value = { ok: false, errors: [{ message: t('apiKeys.noEnvVar') }] };
      return;
    }
    entry.key_env = form.value.envRef;
  } else {
    lastResult.value = { ok: false, errors: [{ message: t('apiKeys.createFlowPrompt') }] };
    return;
  }

  saving.value = true;
  try {
    const result = isEdit
      ? await api.update('api_keys', editing.value.display_name, entry)
      : await api.create('api_keys', entry);
    lastResult.value = result;
    if (result.ok) {
      if (!isEdit && generatedPlaintext.value) {
        return; // modal stays; user copies then closes
      }
      editing.value = null;
      await load();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

function closeAfterCreated() {
  generatedPlaintext.value = '';
  editing.value = null;
  load();
}

async function remove(e) {
  const label = e.display_name || e.key_hash.slice(0, 8);
  if (!confirm(t('apiKeys.deleteConfirm', { name: label }))) return;
  try {
    const r = await api.remove('api_keys', e.display_name || e.key_hash);
    lastResult.value = r;
    if (r.ok) await load();
  } catch (err) {
    lastResult.value = { ok: false, errors: [{ message: err.message }] };
  }
}

async function copyPlaintext() {
  try {
    await navigator.clipboard.writeText(generatedPlaintext.value);
    alert(t('apiKeys.copied'));
  } catch {
    /* clipboard may be unavailable */
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="lastResult && !lastResult.ok" class="error-box">
      <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <h3 style="margin: 0">{{ t('apiKeys.title') }}</h3>
        <button class="primary" @click="openCreate">+ {{ t('common.add') }}</button>
      </div>
      <p class="muted" style="margin-bottom: 0">{{ t('apiKeys.hint') }}</p>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>{{ t('common.name') }}</th><th>{{ t('apiKeys.colHash') }}</th><th>{{ t('apiKeys.colAllowedModels') }}</th><th>{{ t('apiKeys.colExpires') }}</th><th>{{ t('common.status') }}</th><th>{{ t('common.actions') }}</th></tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td colspan="6" class="muted">{{ t('apiKeys.empty') }}</td>
          </tr>
          <tr v-for="e in entries" :key="e.key_hash">
            <td>{{ e.display_name || e.key_env || t('apiKeys.unlabeled') }}</td>
            <td><code>{{ (e.key_hash || '').slice(0, 8) }}</code> <span class="muted" v-if="e.key_env">{{ e.key_env }}</span></td>
            <td class="muted">{{ (e.allowed_models || []).join(', ') || t('apiKeys.emptyDeniesAll') }}</td>
            <td>{{ e.expires_at ? new Date(e.expires_at).toLocaleString() : '—' }}</td>
            <td>
              <span v-if="e.disabled" class="badge err">{{ t('common.disabled') }}</span>
              <span v-else class="badge ok">{{ t('common.enabled') }}</span>
            </td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">{{ t('common.edit') }}</button>
              <button class="danger" @click="remove(e)">{{ t('common.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="editing.display_name ? t('apiKeys.edit', { name: editing.display_name }) : t('apiKeys.add')" @close="generatedPlaintext ? closeAfterCreated() : (editing = null)">
      <div v-if="generatedPlaintext" style="text-align: center; padding: 8px 0">
        <div class="warn-box" style="text-align: left">{{ t('apiKeys.revealWarning') }}</div>
        <code style="font-size: 14px; word-break: break-all; user-select: all">{{ generatedPlaintext }}</code>
        <div style="margin-top: 12px">
          <button class="primary" @click="copyPlaintext">{{ t('apiKeys.copyAndClose') }}</button>
        </div>
      </div>

      <template v-else>
        <div class="form-row">
          <label>{{ t('common.name') }} *</label>
          <input v-model="form.display_name" placeholder="local-dev" />
        </div>

        <template v-if="!editing.display_name">
          <div class="form-row">
            <label>{{ t('apiKeys.createFlowPrompt') }}</label>
            <div style="display: flex; flex-direction: column; gap: 6px">
              <label><input type="radio" v-model="form.mode" value="generate" /> {{ t('apiKeys.modeGenerate') }}</label>
              <label><input type="radio" v-model="form.mode" value="import" /> {{ t('apiKeys.modeImport') }}</label>
              <label><input type="radio" v-model="form.mode" value="envref" /> {{ t('apiKeys.modeEnv') }}</label>
            </div>
          </div>
          <div class="form-row" v-if="form.mode === 'import'">
            <label>{{ t('apiKeys.importKeyLabel') }}</label>
            <input v-model="form.importPlaintext" type="password" :placeholder="t('apiKeys.importPlaceholder')" style="width: 100%" />
          </div>
          <div class="form-row" v-if="form.mode === 'envref'">
            <label>{{ t('apiKeys.envVarName') }}</label>
            <input v-model="form.envRef" placeholder="CALLER_API_KEY" />
          </div>
        </template>

        <div class="form-row">
          <label>{{ t('apiKeys.allowedModels') }}</label>
          <div>
            <div v-for="(m, i) in form.allowed_models" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
              <input v-model="form.allowed_models[i]" :placeholder="i === 0 ? t('apiKeys.allStarPlaceholder') : t('apiKeys.modelNamePlaceholder')" style="flex: 1" />
              <button @click="removeAllowedModel(i)">✕</button>
            </div>
            <div style="display: flex; gap: 6px; align-items: center">
              <button @click="addAllowedModel">+ {{ t('common.add') }}</button>
              <span class="muted" style="font-size: 12px">{{ t('apiKeys.emptyDeniesAll') }}</span>
            </div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('apiKeys.expiresAt') }}</label>
          <input v-model="form.expires_at" type="datetime-local" />
        </div>
        <div class="form-row">
          <label>{{ t('apiKeys.rateLimitRpm') }}</label>
          <input v-model="form.rate_rpm" type="number" />
        </div>
        <div class="form-row">
          <label>{{ t('common.disabled') }}</label>
          <label style="justify-self: start"><input type="checkbox" v-model="form.disabled" /></label>
        </div>
        <div class="muted" v-if="editing.display_name" style="font-size: 12px; margin-bottom: 8px">{{ t('apiKeys.immutableHint') }}</div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
          <button @click="editing = null">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.saveAndReload') }}</button>
        </div>
        <div v-if="lastResult && lastResult.ok && !generatedPlaintext" class="badge ok" style="margin-top: 10px">
          {{ t('common.saved') }}{{ lastResult.reload?.warning ? t('common.sep') + t('save.reloadWarning') : '' }}
        </div>
      </template>
    </Modal>
  </div>
</template>
