<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import RawYamlEditor from '../components/RawYamlEditor.vue';

const { t } = useI18n();
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
  if (!confirm(t('dashboard.fileMissing') + '\n\n' + t('common.confirm') + '?')) return;
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
        <h3 style="margin: 0">{{ t('raw.title') }}</h3>
        <div>
          <button style="margin-right: 6px" @click="load">{{ t('raw.reload') }}</button>
          <button class="danger" style="margin-right: 6px" @click="bootstrap">{{ t('raw.reset') }}</button>
          <button class="primary" :disabled="saving" @click="save">{{ saving ? t('raw.saving') : t('raw.save') }}</button>
        </div>
      </div>
      <RawYamlEditor v-model="text" :rows="24" />
      <div v-if="lastResult?.ok" class="badge ok" style="margin-top: 10px">
        {{ t('common.saved') }}{{ lastResult.reload?.warning ? '；' + t('save.reloadWarning') : '' }}
      </div>
    </div>
  </div>
</template>
