import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { titleKey: 'app.nav.dashboard' } },
    { path: '/provider-keys', name: 'provider-keys', component: () => import('./views/ProviderKeys.vue'), meta: { titleKey: 'app.nav.providerKeys' } },
    { path: '/models', name: 'models', component: () => import('./views/Models.vue'), meta: { titleKey: 'app.nav.models' } },
    { path: '/api-keys', name: 'api-keys', component: () => import('./views/ApiKeys.vue'), meta: { titleKey: 'app.nav.apiKeys' } },
    { path: '/policies', name: 'policies', component: () => import('./views/Policies.vue'), meta: { titleKey: 'app.nav.policies' } },
    { path: '/playground', name: 'playground', component: () => import('./views/Playground.vue'), meta: { titleKey: 'app.nav.playground' } },
    { path: '/secrets', name: 'secrets', component: () => import('./views/Secrets.vue'), meta: { titleKey: 'app.nav.secrets' } },
    { path: '/raw', name: 'raw', component: () => import('./views/RawYaml.vue'), meta: { titleKey: 'app.nav.raw' } },
  ],
});
