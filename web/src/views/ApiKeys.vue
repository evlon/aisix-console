<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import ResourceFacts from '../components/ResourceFacts.vue';
import { generateCallerKey } from '../lib/keygen.js';
import { sha256Hex } from '../lib/sha256.js';

const { t, te } = useI18n();

// Field labels and help come from the catalogue copy, the same mechanism the
// resource catalogue and the Policies page use: per-kind override, then the
// shared field.*, then the table-column label, then the raw key. The advanced
// section used to show the configuration keys themselves.
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
const models = ref([]);
const mcpServers = ref([]);
const loading = ref(false);
const editing = ref(null);
const saving = ref(false);
const lastResult = ref(null);
const generatedPlaintext = ref('');

// The gateway's RateLimit dimensions. There is no per-hour or per-second TOKEN
// limit upstream, so tpm/tpd are the only token windows.
//
// These MUST stay above `form`: its initializer calls emptyRateLimit(), and a
// `const` arrow function is not hoisted. Declared below, this threw "Cannot
// access 'emptyRateLimit' before initialization" during setup, so the whole page
// rendered as a comment node — nothing in the build or the tests could see it,
// and it shipped in v0.2.1.
const RATE_DIMS = ['rpm', 'rps', 'rph', 'rpd', 'tpm', 'tpd', 'concurrency'];
const emptyRateLimit = () => Object.fromEntries(RATE_DIMS.map((d) => [d, '']));

const form = ref({
  display_name: '',
  mode: 'generate', // 'generate' | 'import' | 'envref'
  importPlaintext: '',
  envRef: '',
  allowed_models: ['*'],
  expires_at: '',
  disabled: false,
  // Every dimension the gateway's RateLimit actually has. `tpm`/`tpd` used to be
  // missing here, which is how an operator could neither see nor restore the
  // token cap that stops one caller consuming the whole quota.
  rate_limit: emptyRateLimit(),
  // aisix >=1.1.0 extras
  allowed_agents: '',
  allowed_routes: '',
  jwt_provider: '',
  jwt_subject: '',
  team_id: '',
  user_id: '',
  user_name: '',
  mcp_access_allow: '',
  mcp_access_deny: '',
  mcp_rate_limits: [], // [{ server, rpm, rps, rph, rpd, tpm, tpd, concurrency }]
});

const emptyAdvanced = () => ({
  allowed_agents: '',
  allowed_routes: '',
  jwt_provider: '',
  jwt_subject: '',
  team_id: '',
  user_id: '',
  user_name: '',
  mcp_access_allow: '',
  mcp_access_deny: '',
  mcp_rate_limits: [],
});

const strArr = (v) =>
  String(v || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

async function load() {
  loading.value = true;
  try {
    const [k, m, s] = await Promise.all([api.list('api_keys'), api.list('models'), api.list('mcp_servers')]);
    entries.value = k.entries ?? [];
    models.value = (m.entries ?? []).map((e) => e.display_name).filter(Boolean);
    mcpServers.value = (s.entries ?? []).map((e) => e.name || e.display_name).filter(Boolean);
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { display_name: '', mode: 'generate', importPlaintext: '', envRef: '', allowed_models: ['*'], expires_at: '', disabled: false, rate_limit: emptyRateLimit(), ...emptyAdvanced() };
  editing.value = {};
  lastResult.value = null;
  generatedPlaintext.value = '';
}

function openEdit(e) {
  const mrl = Object.entries(e.mcp_rate_limits ?? {}).map(([server, v]) => ({
    server,
    ...Object.fromEntries(RATE_DIMS.map((d) => [d, v?.[d] ?? ''])),
  }));
  form.value = {
    display_name: e.display_name ?? '',
    mode: 'generate',
    importPlaintext: '',
    envRef: '',
    allowed_models: [...(e.allowed_models ?? [])],
    expires_at: e.expires_at ?? '',
    disabled: !!e.disabled,
    rate_limit: Object.fromEntries(RATE_DIMS.map((d) => [d, e.rate_limit?.[d] ?? ''])),
    allowed_agents: (e.allowed_agents ?? []).join(', '),
    allowed_routes: (e.allowed_routes ?? []).join(', '),
    jwt_provider: e.jwt_provider ?? '',
    jwt_subject: e.jwt_subject ?? '',
    team_id: e.team_id ?? '',
    user_id: e.user_id ?? '',
    user_name: e.user_name ?? '',
    mcp_access_allow: (e.mcp_access?.allow ?? []).join('\n'),
    mcp_access_deny: (e.mcp_access?.deny ?? []).join('\n'),
    mcp_rate_limits: mrl,
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
function addMcpRateLimit() {
  form.value.mcp_rate_limits.push({ server: '', rpm: '', rps: '', rph: '', rpd: '', concurrency: '' });
}
function removeMcpRateLimit(i) {
  form.value.mcp_rate_limits.splice(i, 1);
}

async function save() {
  if (!form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: t('common.required') }] };
    return;
  }
  // Every field this form OWNS is sent explicitly, and a cleared one is sent as
  // null. Two bugs came from the opposite arrangement: an empty field was simply
  // omitted and the server replaced the row wholesale, so everything the form did
  // not model was silently deleted (the tpm/tpd token caps went on a rename); and
  // once the server started merging, omission would mean "leave alone", so nothing
  // could be cleared at all. Fields this form does NOT model (tags,
  // allowed_model_ids, allow_all_models) stay omitted on purpose — that is what
  // makes the merge preserve them.
  const isEdit = !!editing.value?.display_name;
  const entry = {
    display_name: form.value.display_name,
    allowed_models: form.value.allowed_models.map((m) => m.trim()).filter(Boolean),
  };
  const set = (key, value) => {
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    if (empty) {
      if (isEdit) entry[key] = null;
      return;
    }
    entry[key] = value;
  };

  const limits = {};
  for (const dim of RATE_DIMS) {
    const v = form.value.rate_limit?.[dim];
    if (v !== '' && v !== undefined && v !== null) limits[dim] = Number(v);
  }
  set('rate_limit', Object.keys(limits).length ? limits : '');
  set('expires_at', form.value.expires_at ? new Date(form.value.expires_at).toISOString() : '');
  set('disabled', form.value.disabled ? true : '');

  // aisix >=1.1.0 extras.
  set('allowed_agents', strArr(form.value.allowed_agents));
  set('allowed_routes', strArr(form.value.allowed_routes));
  set('jwt_provider', form.value.jwt_provider);
  set('jwt_subject', form.value.jwt_subject);
  set('team_id', form.value.team_id);
  set('user_id', form.value.user_id);
  set('user_name', form.value.user_name);

  // mcp_access: multiline glob lists -> { allow, deny }.
  const allow = strArr(form.value.mcp_access_allow);
  const deny = strArr(form.value.mcp_access_deny);
  const mcpAccess = {};
  if (allow.length) mcpAccess.allow = allow;
  if (deny.length) mcpAccess.deny = deny;
  set('mcp_access', Object.keys(mcpAccess).length ? mcpAccess : '');

  // mcp_rate_limits: [{server, rpm, ...}] -> { "<server>": { rpm, ... } }.
  const mrl = {};
  for (const row of form.value.mcp_rate_limits) {
    const server = (row.server || '').trim();
    if (!server) continue;
    const dims = {};
    for (const dim of RATE_DIMS) {
      const v = row[dim];
      if (v !== '' && v !== undefined && v !== null) dims[dim] = Number(v);
    }
    if (Object.keys(dims).length) mrl[server] = dims;
  }
  set('mcp_rate_limits', Object.keys(mrl).length ? mrl : '');

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

// navigator.clipboard is secure-context-only too (undefined over plain HTTP on
// an intranet), so fall back to a hidden textarea + execCommand.
function copyViaTextarea(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

async function copyPlaintext() {
  const text = generatedPlaintext.value;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      alert(t('apiKeys.copied'));
      return;
    } catch {
      /* fall through to the textarea path */
    }
  }
  alert(copyViaTextarea(text) ? t('apiKeys.copied') : t('apiKeys.copyManually'));
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="lastResult && !lastResult.ok" class="error-box">
      <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
    </div>

    <!-- The same six questions every resource answers, from the same copy the
         catalogue uses. The hint below stays: it explains the hashing behaviour,
         which is specific to this page. -->
    <ResourceFacts kind="api_keys" />

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
          <div style="display: flex; gap: 6px; flex-wrap: wrap">
            <input
              v-for="d in RATE_DIMS"
              :key="d"
              v-model="form.rate_limit[d]"
              type="number"
              :placeholder="d"
              style="width: 96px"
            />
          </div>
        </div>
        <p class="muted" style="margin: -4px 0 12px; font-size: 12px">{{ t('apiKeys.rateLimitHint') }}</p>
        <div class="form-row">
          <label>{{ t('common.disabled') }}</label>
          <label style="justify-self: start"><input type="checkbox" v-model="form.disabled" /></label>
        </div>
        <details style="margin-top: 10px">
          <summary>{{ t('apiKeys.advanced') }}</summary>
          <div class="form-row">
            <label>{{ FL('api_keys', 'allowed_agents') }}</label>
            <input v-model="form.allowed_agents" placeholder="*, agent-a" />
            <p v-if="FH('api_keys', 'allowed_agents')" class="fh">{{ FH('api_keys', 'allowed_agents') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'allowed_routes') }}</label>
            <input v-model="form.allowed_routes" placeholder="*, route-a" />
            <p v-if="FH('api_keys', 'allowed_routes')" class="fh">{{ FH('api_keys', 'allowed_routes') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'jwt_provider') }}</label>
            <input v-model="form.jwt_provider" placeholder="oidc provider name" />
            <p v-if="FH('api_keys', 'jwt_provider')" class="fh">{{ FH('api_keys', 'jwt_provider') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'jwt_subject') }}</label>
            <input v-model="form.jwt_subject" placeholder="external identity" />
            <p v-if="FH('api_keys', 'jwt_subject')" class="fh">{{ FH('api_keys', 'jwt_subject') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'team_id') }}</label>
            <input v-model="form.team_id" />
            <p v-if="FH('api_keys', 'team_id')" class="fh">{{ FH('api_keys', 'team_id') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'user_id') }}</label>
            <input v-model="form.user_id" />
            <p v-if="FH('api_keys', 'user_id')" class="fh">{{ FH('api_keys', 'user_id') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'user_name') }}</label>
            <input v-model="form.user_name" />
            <p v-if="FH('api_keys', 'user_name')" class="fh">{{ FH('api_keys', 'user_name') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'mcpAccessAllow') }}</label>
            <div style="flex: 1">
              <textarea v-model="form.mcp_access_allow" rows="3" style="width: 100%" placeholder="每行一个 <server>__<tool> glob，如&#10;demo-mcp__*&#10;github__search_repositories" />
              <div style="margin-top: 4px">
                <span class="muted" style="font-size: 12px">插入服务器：</span>
                <button v-for="s in mcpServers" :key="s" @click="form.mcp_access_allow = (form.mcp_access_allow ? form.mcp_access_allow + '\n' : '') + s + '__*'" style="margin: 2px">{{ s }}__*</button>
              </div>
            </div>
            <p v-if="FH('api_keys', 'mcpAccessAllow')" class="fh">{{ FH('api_keys', 'mcpAccessAllow') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'mcpAccessDeny') }}</label>
            <textarea v-model="form.mcp_access_deny" rows="3" style="flex: 1" placeholder="每行一个 <server>__<tool> glob" />
            <p v-if="FH('api_keys', 'mcpAccessDeny')" class="fh">{{ FH('api_keys', 'mcpAccessDeny') }}</p>
          </div>
          <div class="form-row">
            <label>{{ FL('api_keys', 'mcpRateLimits') }}</label>
            <div style="flex: 1">
              <div v-for="(row, i) in form.mcp_rate_limits" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px; align-items: center; flex-wrap: wrap">
                <select v-model="row.server" style="min-width: 140px">
                  <option value="">选择 MCP 服务器…</option>
                  <option v-for="s in mcpServers" :key="s" :value="s">{{ s }}</option>
                </select>
                <input
                  v-for="d in RATE_DIMS"
                  :key="d"
                  v-model="row[d]"
                  type="number"
                  :placeholder="d"
                  style="width: 70px"
                />
                <button @click="removeMcpRateLimit(i)">✕</button>
              </div>
              <button @click="addMcpRateLimit">+ 添加服务器限额</button>
            </div>
            <p v-if="FH('api_keys', 'mcpRateLimits')" class="fh">{{ FH('api_keys', 'mcpRateLimits') }}</p>
          </div>
        </details>
        <div class="muted" v-if="editing.display_name" style="font-size: 12px; margin-bottom: 8px">{{ t('apiKeys.immutableHint') }}</div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
          <button @click="editing = null">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.saveAndReload') }}</button>
        </div>
        <div v-if="lastResult && lastResult.ok && !generatedPlaintext" class="badge ok" style="margin-top: 10px">
          {{ t('common.saved') }}{{ lastResult.reload?.warning ? t('common.sep') + lastResult.reload.warning : '' }}{{ lastResult.notice ? t('common.sep') + lastResult.notice : '' }}
        </div>
      </template>
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