<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import { generateCallerKey } from '../lib/keygen.js';
import { sha256Hex } from '../lib/sha256.js';

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
    lastResult.value = { ok: false, errors: [{ message: 'display_name 必填' }] };
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
        lastResult.value = { ok: false, errors: [{ message: '请粘贴要导入的 API Key 明文' }] };
        return;
      }
    }
    entry.key_hash = await sha256Hex(plaintext);
    generatedPlaintext.value = plaintext; // shown once in the modal
  } else if (form.value.mode === 'envref') {
    if (!form.value.envRef) {
      lastResult.value = { ok: false, errors: [{ message: '请填写环境变量名' }] };
      return;
    }
    entry.key_env = form.value.envRef;
  } else {
    lastResult.value = { ok: false, errors: [{ message: '请选择创建方式' }] };
    return;
  }

  saving.value = true;
  try {
    const result = isEdit
      ? await api.update('api_keys', editing.value.display_name, entry)
      : await api.create('api_keys', entry);
    lastResult.value = result;
    if (result.ok) {
      if (!isEdit) {
        // keep modal open to reveal the plaintext once
        if (generatedPlaintext.value) {
          return; // modal stays; user copies then closes
        }
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
  if (!confirm(`删除 API Key "${e.display_name || e.key_hash.slice(0, 8)}"？`)) return;
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
    alert('已复制。关闭后无法再次查看。');
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
        <h3 style="margin: 0">调用方 API Keys</h3>
        <button class="primary" @click="openCreate">+ 新增</button>
      </div>
      <p class="muted" style="margin-bottom: 0">
        只保存 SHA-256 哈希，明文仅在你创建时展示一次。网关收到调用后自行哈希比对。
      </p>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>名称</th><th>Hash 前缀</th><th>允许模型</th><th>过期</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td colspan="6" class="muted">暂无 API Key</td>
          </tr>
          <tr v-for="e in entries" :key="e.key_hash">
            <td>{{ e.display_name || e.key_env || '(未命名)' }}</td>
            <td><code>{{ (e.key_hash || '').slice(0, 8) }}</code> <span class="muted" v-if="e.key_env">{{ e.key_env }}</span></td>
            <td class="muted">{{ (e.allowed_models || []).join(', ') || '（全部拒绝）' }}</td>
            <td>{{ e.expires_at ? new Date(e.expires_at).toLocaleString() : '—' }}</td>
            <td>
              <span v-if="e.disabled" class="badge err">禁用</span>
              <span v-else class="badge ok">启用</span>
            </td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">编辑</button>
              <button class="danger" @click="remove(e)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="editing.display_name ? `编辑 ${editing.display_name}` : '新增 API Key'" @close="generatedPlaintext ? closeAfterCreated() : (editing = null)">
      <div v-if="generatedPlaintext" style="text-align: center; padding: 8px 0">
        <div class="warn-box" style="text-align: left">⚠️ 此明文只会显示这一次，关闭后无法再次查看。请立即保存。</div>
        <code style="font-size: 14px; word-break: break-all; user-select: all">{{ generatedPlaintext }}</code>
        <div style="margin-top: 12px">
          <button class="primary" @click="copyPlaintext">复制并关闭</button>
        </div>
      </div>

      <template v-else>
        <div class="form-row">
          <label>名称 *</label>
          <input v-model="form.display_name" placeholder="如 local-dev" />
        </div>

        <template v-if="!editing.display_name">
          <div class="form-row">
            <label>创建方式</label>
            <div style="display: flex; flex-direction: column; gap: 6px">
              <label><input type="radio" v-model="form.mode" value="generate" /> 生成新 Key（推荐）</label>
              <label><input type="radio" v-model="form.mode" value="import" /> 导入已有 Key（粘贴明文，浏览器内哈希）</label>
              <label><input type="radio" v-model="form.mode" value="envref" /> 引用环境变量 key_env（明文存控制台密钥库）</label>
            </div>
          </div>
          <div class="form-row" v-if="form.mode === 'import'">
            <label>明文 Key</label>
            <input v-model="form.importPlaintext" type="password" placeholder="sk-..." style="width: 100%" />
          </div>
          <div class="form-row" v-if="form.mode === 'envref'">
            <label>环境变量名</label>
            <input v-model="form.envRef" placeholder="CALLER_API_KEY" />
          </div>
        </template>

        <div class="form-row">
          <label>允许的模型</label>
          <div>
            <div v-for="(m, i) in form.allowed_models" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
              <input v-model="form.allowed_models[i]" :placeholder="i === 0 ? '*' : '模型名'" style="flex: 1" />
              <button @click="removeAllowedModel(i)">✕</button>
            </div>
            <div style="display: flex; gap: 6px; align-items: center">
              <button @click="addAllowedModel">+ 添加</button>
              <span class="muted" style="font-size: 12px">留空表示拒绝所有；* 表示全部</span>
            </div>
          </div>
        </div>
        <div class="form-row">
          <label>过期时间</label>
          <input v-model="form.expires_at" type="datetime-local" />
        </div>
        <div class="form-row">
          <label>限流 rpm</label>
          <input v-model="form.rate_rpm" type="number" placeholder="不设" />
        </div>
        <div class="form-row">
          <label>禁用</label>
          <label style="justify-self: start"><input type="checkbox" v-model="form.disabled" /></label>
        </div>
        <div class="muted" v-if="editing.display_name" style="font-size: 12px; margin-bottom: 8px">
          密钥不可修改——需要更换请删除后重建。
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
          <button @click="editing = null">取消</button>
          <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存（校验并写文件）' }}</button>
        </div>
        <div v-if="lastResult && lastResult.ok && !generatedPlaintext" class="badge ok" style="margin-top: 10px">
          已保存{{ lastResult.reload?.warning ? '；' + lastResult.reload.warning : '' }}
        </div>
      </template>
    </Modal>
  </div>
</template>
