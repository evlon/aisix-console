<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';

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
});

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
  };
  editing.value = e;
  lastResult.value = null;
}

async function save() {
  if (!form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: 'display_name 必填' }] };
    return;
  }
  saving.value = true;
  try {
    const entry = { ...form.value };
    delete entry.keyMode;
    delete entry.envRef;
    delete entry.api_key;

    if (form.value.keyMode === 'envref') {
      const varName = form.value.envRef || `EXISTING_VAR`;
      entry.api_key = `\${${varName}}`;
    } else if (form.value.api_key) {
      const name = await allocateProviderVar(form.value.display_name, form.value.api_key);
      entry.api_key = `\${${name}}`;
    } else if (editing.value?.api_key) {
      entry.api_key = editing.value.api_key; // keep existing (masked / env ref)
    } else {
      lastResult.value = { ok: false, errors: [{ message: '请输入 API Key（或选择引用环境变量）' }] };
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

async function allocateProviderVar(displayName, value) {
  const { setSecret } = await import('../api.js');
  const slug = displayName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'KEY';
  const name = `AISIX_CONSOLE_PK_${slug}`;
  await setSecret(name, value);
  return name;
}

async function remove(e) {
  if (!confirm(`删除 Provider Key "${e.display_name}"？\n引用了它的模型将无法工作。`)) return;
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
  return k ? '••••••••（已设置）' : '（未设置）';
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
        <h3 style="margin: 0">Provider Keys</h3>
        <button class="primary" @click="openCreate">+ 新增</button>
      </div>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>名称</th><th>Provider</th><th>Adapter</th><th>API Base</th><th>API Key</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td colspan="6" class="muted">暂无 Provider Key</td>
          </tr>
          <tr v-for="e in entries" :key="e.display_name">
            <td>{{ e.display_name }}</td>
            <td>{{ e.provider || '—' }}</td>
            <td>{{ e.adapter || '—' }}</td>
            <td class="muted">{{ e.api_base || '—' }}</td>
            <td>{{ maskKey(e.api_key) }}</td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">编辑</button>
              <button class="danger" @click="remove(e)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="editing.display_name ? `编辑 ${editing.display_name}` : '新增 Provider Key'" @close="editing = null">
      <div class="form-row">
        <label>名称 *</label>
        <input v-model="form.display_name" placeholder="如 openai-main" />
      </div>
      <div class="form-row">
        <label>Provider</label>
        <input v-model="form.provider" placeholder="openai / deepseek / 自定义厂商" />
      </div>
      <div class="form-row">
        <label>Adapter</label>
        <select v-model="form.adapter">
          <option value="">自动（跟随 provider）</option>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="bedrock">bedrock</option>
          <option value="vertex">vertex</option>
          <option value="azure-openai">azure-openai</option>
        </select>
      </div>
      <div class="form-row">
        <label>API Base</label>
        <input v-model="form.api_base" placeholder="https://api.openai.com/v1（自建/兼容端点必填）" />
      </div>
      <div class="form-row">
        <label>API Key</label>
        <div>
          <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px">
            <input type="radio" v-model="form.keyMode" value="console" />
            存入控制台密钥库（写入 secrets.env，文件里只留 ${VAR}）
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="radio" v-model="form.keyMode" value="envref" />
            引用已有环境变量
          </label>
          <input
            v-if="form.keyMode === 'console'"
            v-model="form.api_key"
            type="password"
            :placeholder="editing.display_name ? '留空保持不变' : 'sk-...'"
            style="width: 100%; margin-top: 6px"
          />
          <input
            v-else
            v-model="form.envRef"
            placeholder="OPENAI_API_KEY（不带 ${}）"
            style="width: 100%; margin-top: 6px"
          />
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
        <button @click="editing = null">取消</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存（校验并写文件）' }}</button>
      </div>
      <div v-if="lastResult && lastResult.ok" class="badge ok" style="margin-top: 10px">
        已保存{{ lastResult.reload?.warning ? '；' + lastResult.reload.warning : '' }}
      </div>
    </Modal>
  </div>
</template>
