<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const vars = ref([]);
const loading = ref(false);
const lastResult = ref(null);
const newName = ref('');
const newValue = ref('');

async function load() {
  loading.value = true;
  try {
    const r = await api.secrets();
    vars.value = r.vars ?? [];
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

async function add() {
  if (!newName.value || !newValue.value) return;
  try {
    await api.setSecret(newName.value.trim(), newValue.value);
    newName.value = '';
    newValue.value = '';
    await load();
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  }
}

async function remove(name) {
  if (!confirm(`删除环境变量 ${name}？\n引用它的 ${'${' + name + '}'} 将无法解析。`)) return;
  try {
    await api.deleteSecret(name);
    await load();
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
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
      <h3 style="margin-top: 0">密钥库（secrets.env）</h3>
      <p class="muted" style="margin-top: -6px">
        控制台在这里保存 Provider Key / key_env 的明文值，resources.yaml 里只引用 <code>${VAR}</code>。
        值不会通过 API 返回。保存时这些变量会注入 <code>aisix validate</code> 的环境。
      </p>
      <div class="warn-box">
        要让网关真正用上这些密钥，需要把 <code>secrets.env</code> 注入网关进程环境：
        <ul style="margin: 6px 0 0; padding-left: 18px">
          <li>Docker：<code>docker run --env-file ./secrets.env ...</code></li>
          <li>systemd：<code>EnvironmentFile=/path/to/secrets.env</code></li>
          <li>手动：<code>set -a; . secrets.env; set +a</code> 后再启动 aisix</li>
        </ul>
      </div>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>变量名</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="!vars.length">
            <td colspan="3" class="muted">暂无密钥</td>
          </tr>
          <tr v-for="v in vars" :key="v.name">
            <td><code>{{ v.name }}</code></td>
            <td><span class="badge ok">已设置</span></td>
            <td><button class="danger" @click="remove(v.name)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <div style="display: flex; gap: 8px; margin-top: 14px">
        <input v-model="newName" placeholder="变量名（如 MY_API_KEY）" style="flex: 2" />
        <input v-model="newValue" type="password" placeholder="值" style="flex: 3" />
        <button class="primary" @click="add">添加</button>
      </div>
    </div>
  </div>
</template>
