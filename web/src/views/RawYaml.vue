<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import RawYamlEditor from '../components/RawYamlEditor.vue';

const raw = ref({ ok: false, exists: false, text: '', error: null });
const text = ref('');
const saving = ref(false);
const lastResult = ref(null);

async function load() {
  try {
    raw.value = await api.raw();
    text.value = raw.value.text;
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  }
}

async function save() {
  saving.value = true;
  try {
    const r = await api.saveRaw(text.value);
    lastResult.value = r;
    if (r.ok) await load();
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function bootstrap() {
  if (!confirm('用空模板覆盖创建 resources.yaml？将丢失现有文件。')) return;
  try {
    const r = await api.bootstrap();
    lastResult.value = r;
    if (r.ok) await load();
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
    <div v-if="raw.error" class="error-box">{{ raw.error }}</div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px">
        <h3 style="margin: 0">原始 resources.yaml</h3>
        <div>
          <button style="margin-right: 6px" @click="load">重新读取</button>
          <button class="danger" style="margin-right: 6px" @click="bootstrap">重置为空模板</button>
          <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存（校验并写文件）' }}</button>
        </div>
      </div>
      <RawYamlEditor v-model="text" :rows="24" />
      <div v-if="lastResult?.ok" class="badge ok" style="margin-top: 10px">
        已保存{{ lastResult.reload?.warning ? '；' + lastResult.reload.warning : '' }}
      </div>
    </div>
  </div>
</template>
