// Pinia store polling /api/status every 5s (pauses when the tab is hidden).
import { defineStore } from 'pinia';
import { api } from '../api.js';

export const useStatusStore = defineStore('status', {
  state: () => ({
    data: null,
    loading: false,
    lastError: null,
    timer: null,
  }),
  getters: {
    gatewayReachable: (s) => !!s.data?.gatewayReachable,
    configState: (s) => s.data?.config?.data?.state ?? null,
    counts: (s) => s.data?.file?.counts ?? {},
    modelsHealth: (s) => (s.data?.models?.data ?? []),
    config: (s) => s.data?.config?.data ?? null,
    fileError: (s) => s.data?.file?.error ?? null,
    fileOk: (s) => s.data?.file?.ok ?? false,
    fileExists: (s) => s.data?.file?.exists ?? false,
  },
  actions: {
    async refresh() {
      this.loading = true;
      try {
        this.data = await api.status();
        this.lastError = null;
      } catch (e) {
        this.lastError = e.message;
      } finally {
        this.loading = false;
      }
    },
    startPolling() {
      if (this.timer) return;
      const tick = () => {
        if (!document.hidden) this.refresh();
      };
      this.refresh();
      this.timer = setInterval(tick, 5000);
      document.addEventListener('visibilitychange', tick);
    },
    stopPolling() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      document.removeEventListener('visibilitychange', () => {});
    },
  },
});
