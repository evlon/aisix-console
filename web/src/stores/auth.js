// Auth state: whether the current browser session is logged in.
import { defineStore } from 'pinia';
import { api, setOnUnauthorized } from '../api.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    authed: false,
    checking: true,
  }),
  actions: {
    async bootstrap() {
      setOnUnauthorized(() => {
        this.authed = false;
      });
      try {
        const r = await api.authStatus();
        this.authed = !!r.authed;
      } catch {
        this.authed = false;
      } finally {
        this.checking = false;
      }
    },
    async login(password) {
      await api.login(password);
      this.authed = true;
    },
    async logout() {
      try {
        await api.logout();
      } catch {
        /* ignore */
      }
      this.authed = false;
    },
    async changePassword(current, next) {
      await api.changePassword(current, next);
      this.authed = false; // forced re-login after password change
    },
  },
});
