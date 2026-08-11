<script setup>
import { onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { useRouter } from 'vue-router';
import { useStatusStore } from './stores/status.js';
import Toast from './components/Toast.vue';

const router = useRouter();
const status = useStatusStore();
const toastEl = useTemplateRef('toast');

const nav = [
  { path: '/', label: '仪表盘' },
  { path: '/provider-keys', label: 'Provider Keys' },
  { path: '/models', label: '模型' },
  { path: '/api-keys', label: 'API Keys' },
  { path: '/policies', label: '策略' },
  { path: '/playground', label: '试玩' },
  { path: '/secrets', label: '密钥' },
  { path: '/raw', label: '原始 YAML' },
];

onMounted(() => status.startPolling());
onUnmounted(() => status.stopPolling());
</script>

<template>
  <div style="display: flex; min-height: 100vh">
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
          {{ item.label }}
        </router-link>
      </nav>
      <div style="margin-top: 24px; font-size: 12px" class="muted">
        <div>
          网关状态：
          <span v-if="status.loading && !status.data" class="muted">检测中…</span>
          <span v-else-if="status.gatewayReachable" class="badge ok">在线</span>
          <span v-else class="badge err">离线</span>
        </div>
        <div style="margin-top: 6px">
          配置：
          <span v-if="status.configState" class="badge" :class="stateClass(status.configState)">
            {{ stateLabel(status.configState) }}
          </span>
          <span v-else class="muted">—</span>
        </div>
      </div>
    </aside>

    <main style="flex: 1; padding: 20px 28px; overflow: auto">
      <h1 style="margin-top: 0; font-size: 20px">{{ router.currentRoute.value.meta.title || 'AISIX Console' }}</h1>
      <router-view />
    </main>

    <Toast ref="toast" />
  </div>
</template>

<script>
export default {
  methods: {
    stateClass(s) {
      return { synced: 'ok', degraded: 'warn', out_of_sync: 'err', empty: 'warn', never_loaded: 'err' }[s] || '';
    },
    stateLabel(s) {
      return {
        synced: '已同步',
        degraded: '降级',
        out_of_sync: '失步',
        empty: '空',
        never_loaded: '未加载',
      }[s] || s;
    },
  },
};
</script>

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
</style>
