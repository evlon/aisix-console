<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth.js';

const { t } = useI18n();
const auth = useAuthStore();
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  if (!password.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await auth.login(password.value);
  } catch (e) {
    const key = `auth.errors.${e.message}`;
    error.value = t(key) !== key ? t(key) : e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="card login-card">
      <h2 style="margin: 0 0 4px">AISIX <span class="muted">Console</span></h2>
      <p class="muted" style="margin: 0 0 16px">{{ t('login.title') }}</p>
      <div v-if="error" class="error-box">{{ error }}</div>
      <input
        v-model="password"
        type="password"
        :placeholder="t('login.passwordPlaceholder')"
        autofocus
        style="width: 100%; margin-bottom: 10px"
        @keydown.enter.prevent="submit"
      />
      <button class="primary" style="width: 100%" :disabled="busy" @click="submit">
        {{ busy ? t('login.signingIn') : t('login.signIn') }}
      </button>
      <p class="muted" style="margin: 14px 0 0; font-size: 12px">{{ t('login.defaultHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-card {
  width: min(360px, 90vw);
  padding: 28px;
}
</style>
