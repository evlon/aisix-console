<script setup>
import { onMounted, onUnmounted, useTemplateRef } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useStatusStore } from './stores/status.js';
import { useAuthStore } from './stores/auth.js';
import Login from './views/Login.vue';
import Toast from './components/Toast.vue';

const router = useRouter();
const status = useStatusStore();
const auth = useAuthStore();
const { t } = useI18n();
const toastEl = useTemplateRef('toast');

const nav = [
  { path: '/', key: 'app.nav.dashboard' },
  { path: '/provider-keys', key: 'app.nav.providerKeys' },
  { path: '/models', key: 'app.nav.models' },
  { path: '/api-keys', key: 'app.nav.apiKeys' },
  { path: '/policies', key: 'app.nav.policies' },
  { path: '/resources', key: 'app.nav.resources' },
  { path: '/playground', key: 'app.nav.playground' },
  { path: '/secrets', key: 'app.nav.secrets' },
  { path: '/raw', key: 'app.nav.raw' },
  { path: '/settings', key: 'app.nav.settings' },
];

const stateClass = (s) =>
  ({ synced: 'ok', degraded: 'warn', out_of_sync: 'err', empty: 'warn', never_loaded: 'err' }[s] || '');

const stateLabel = (s) =>
  ({
    synced: 'synced',
    degraded: 'degraded',
    out_of_sync: 'out of sync',
    empty: 'empty',
    never_loaded: 'not loaded',
  }[s] || s);

onMounted(() => {
  auth.bootstrap();
  status.startPolling();
});
onUnmounted(() => status.stopPolling());
</script>

<template>
  <div v-if="auth.checking" style="min-height: 100vh; display: flex; align-items: center; justify-content: center" class="muted">
    {{ t('app.checking') }}
  </div>

  <Login v-else-if="!auth.authed" />

  <div v-else style="display: flex; min-height: 100vh">
    <aside style="width: 200px; border-right: 1px solid var(--border); padding: 16px 12px; flex-shrink: 0">
      <div style="font-size: 16px; font-weight: 700; margin-bottom: 16px">
        AISIX <span class="muted" style="font-weight: 400">Console</span>
      </div>
      <nav style="display: flex; flex-direction: column; gap: 2px">
        <router-link
          v-for="item in nav"
          :key="item.path"
          :to="item.path"
          class="nav-link"
          :class="{ active: router.currentRoute.value.path === item.path }"
        >
          {{ t(item.key) }}
        </router-link>
      </nav>
      <div style="margin-top: 24px; font-size: 12px" class="muted">
        <div>
          {{ t('app.gatewayStatus') }}：
          <span v-if="status.loading && !status.data" class="muted">{{ t('app.checking') }}</span>
          <span v-else-if="status.gatewayReachable" class="badge ok">{{ t('app.online') }}</span>
          <span v-else class="badge err">{{ t('app.offline') }}</span>
        </div>
        <div style="margin-top: 6px">
          {{ t('app.configState') }}：
          <span v-if="status.configState" class="badge" :class="stateClass(status.configState)">
            {{ stateLabel(status.configState) }}
          </span>
          <span v-else class="muted">—</span>
        </div>
      </div>
      <div style="margin-top: 16px">
        <button
          class="lang-toggle"
          :class="{ active: $i18n.locale === 'zh-CN' }"
          @click="$i18n.locale = 'zh-CN'; localStorage.setItem('aisix_console_lang', 'zh-CN')"
        >
          中文
        </button>
        <button
          class="lang-toggle"
          :class="{ active: $i18n.locale === 'en' }"
          @click="$i18n.locale = 'en'; localStorage.setItem('aisix_console_lang', 'en')"
        >
          EN
        </button>
      </div>
    </aside>

    <main style="flex: 1; padding: 20px 28px; overflow: auto">
      <h1 style="margin-top: 0; font-size: 20px">{{ t(router.currentRoute.value.meta.titleKey || 'app.title') }}</h1>
      <router-view />
    </main>

    <Toast ref="toast" />
  </div>
</template>

<style scoped>
.nav-link {
  display: block;
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--muted);
}

.nav-link:hover {
  background: #1b202c;
  color: var(--text);
}

.nav-link.active {
  background: #232b3d;
  color: var(--text);
}

.lang-toggle {
  padding: 3px 10px;
  margin-right: 4px;
  font-size: 12px;
}

.lang-toggle.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
</style>
