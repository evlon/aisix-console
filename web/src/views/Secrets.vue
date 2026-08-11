<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';

const { t } = useI18n();
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
  if (!confirm(t('secrets.deleteConfirm', { name }))) return;
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
      <h3 style="margin-top: 0">{{ t('secrets.title') }}</h3>
      <p class="muted" style="margin-top: -6px">{{ t('secrets.hint') }}</p>
      <div class="warn-box">
        {{ t('secrets.wiringHint') }}
        <ul style="margin: 6px 0 0; padding-left: 18px">
          <li>Docker: <code>docker run --env-file ./secrets.env ...</code></li>
          <li>systemd: <code>EnvironmentFile=/path/to/secrets.env</code></li>
          <li>shell: <code>set -a; . secrets.env; set +a</code></li>
        </ul>
      </div>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>{{ t('secrets.varName') }}</th><th>{{ t('common.status') }}</th><th>{{ t('common.actions') }}</th></tr>
        </thead>
        <tbody>
          <tr v-if="!vars.length">
            <td colspan="3" class="muted">{{ t('secrets.empty') }}</td>
          </tr>
          <tr v-for="v in vars" :key="v.name">
            <td><code>{{ v.name }}</code></td>
            <td><span class="badge ok">{{ t('secrets.set') }}</span></td>
            <td><button class="danger" @click="remove(v.name)">{{ t('common.delete') }}</button></td>
          </tr>
        </tbody>
      </table>
      <div style="display: flex; gap: 8px; margin-top: 14px">
        <input v-model="newName" :placeholder="t('secrets.namePlaceholder')" style="flex: 2" />
        <input v-model="newValue" type="password" :placeholder="t('secrets.valuePlaceholder')" style="flex: 3" />
        <button class="primary" @click="add">{{ t('secrets.addVar') }}</button>
      </div>
    </div>
  </div>
</template>
