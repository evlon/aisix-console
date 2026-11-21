<script setup>
// File-format banner.
//
// The resources file's `_format_version` is a file-level fact that decides
// whether the gateway can load it at all, so it belongs on every page rather
// than on one of them.
//
// Background: aisix 1.11 (#1449) made `_format_version` a hard equality check
// ("2") and removed the name→id sugar layer, so a v1 file — what this console
// wrote until now — fails the ENTIRE load on 1.11+, and a v2 file fails on
// 1.10 and older. The migration below is self-guarding: it goes through the
// normal save pipeline, which runs `aisix validate` with the configured
// gateway binary, so a gateway that cannot read format 2 rejects the write and
// nothing changes.
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';

const { t } = useI18n();

const meta = ref(null);
const busy = ref(false);
const result = ref(null);

async function load() {
  try {
    meta.value = await api.resourcesMeta();
  } catch {
    meta.value = null; // an unreadable file is the Dashboard's story to tell
  }
}

async function migrate() {
  if (!confirm(t('fmt.migrateConfirm'))) return;
  busy.value = true;
  result.value = null;
  try {
    const r = await api.migrateFormatV2();
    result.value = r;
    if (r.ok) {
      meta.value = { ...(meta.value ?? {}), formatVersion: '2' };
      if (r.alreadyV2) result.value = { ...r, ok: true };
    }
  } catch (e) {
    result.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-if="meta?.ok && meta.formatVersion === '1'" class="warn-box" style="margin-bottom: 14px">
    <div style="display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap">
      <strong>{{ t('fmt.v1Title') }}</strong>
      <span style="font-size: 12px">{{ t('fmt.v1Body') }}</span>
      <button class="primary" :disabled="busy" style="margin-left: auto" @click="migrate">
        {{ busy ? t('fmt.migrating') : t('fmt.migrate') }}
      </button>
    </div>
    <div v-if="result && !result.ok" class="error-box" style="margin-top: 8px">
      <div v-for="(e, i) in result.errors || [{ message: 'failed' }]" :key="i">- {{ e.message }}</div>
      <div v-if="result.hint" style="margin-top: 4px">{{ result.hint }}</div>
    </div>
  </div>

  <div v-else-if="result?.ok" class="scrape-info" style="margin-bottom: 14px">
    <span class="badge ok">{{ t('fmt.migrated') }}</span>
    <span class="muted" style="margin-left: 8px">{{ t('fmt.reloadHint') }}</span>
    <button style="margin-left: 8px; padding: 2px 10px; font-size: 12px" @click="location.reload()">
      {{ t('fmt.reload') }}
    </button>
  </div>
</template>
