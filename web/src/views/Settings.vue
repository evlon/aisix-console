<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth.js';

const { t } = useI18n();
const auth = useAuthStore();

const current = ref('');
const next = ref('');
const confirm = ref('');
const error = ref('');
const ok = ref(false);
const busy = ref(false);

async function submit() {
  error.value = '';
  ok.value = false;
  if (next.value.length < 6) {
    error.value = t('settings.tooShort');
    return;
  }
  if (next.value !== confirm.value) {
    error.value = t('settings.mismatch');
    return;
  }
  busy.value = true;
  try {
    await auth.changePassword(current.value, next.value);
    ok.value = true;
    current.value = '';
    next.value = '';
    confirm.value = '';
  } catch (e) {
    const key = `auth.errors.${e.message}`;
    error.value = t(key) !== key ? t(key) : e.message;
  } finally {
    busy.value = false;
  }
}

async function doLogout() {
  await auth.logout();
}
</script>

<template>
  <div>
    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="ok" class="warn-box">{{ t('settings.changedRelogin') }}</div>

    <div class="card" style="max-width: 520px">
      <h3 style="margin-top: 0">{{ t('settings.title') }}</h3>

      <div class="form-row">
        <label>{{ t('settings.currentPassword') }} *</label>
        <input v-model="current" type="password" />
      </div>
      <div class="form-row">
        <label>{{ t('settings.newPassword') }} *</label>
        <input v-model="next" type="password" />
      </div>
      <div class="form-row">
        <label>{{ t('settings.confirmPassword') }} *</label>
        <input v-model="confirm" type="password" />
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px">
        <button @click="doLogout">{{ t('settings.logout') }}</button>
        <button class="primary" :disabled="busy" @click="submit">
          {{ busy ? t('common.saving') : t('settings.changePassword') }}
        </button>
      </div>
    </div>

    <div class="card" style="max-width: 520px">
      <h3 style="margin-top: 0">{{ t('settings.security') }}</h3>
      <p class="muted" style="margin: 0">
        {{ t('settings.securityHint') }}
        <code>{{ t('settings.defaultPassword') }}</code>
      </p>
      <p class="muted" style="margin: 10px 0 0; font-size: 12px">{{ t('settings.authFileHint') }}</p>
    </div>
  </div>
</template>
