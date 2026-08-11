import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '仪表盘' } },
    { path: '/provider-keys', name: 'provider-keys', component: () => import('./views/ProviderKeys.vue'), meta: { title: 'Provider Keys' } },
    { path: '/models', name: 'models', component: () => import('./views/Models.vue'), meta: { title: '模型' } },
    { path: '/api-keys', name: 'api-keys', component: () => import('./views/ApiKeys.vue'), meta: { title: '调用方 API Keys' } },
    { path: '/policies', name: 'policies', component: () => import('./views/Policies.vue'), meta: { title: '策略' } },
    { path: '/playground', name: 'playground', component: () => import('./views/Playground.vue'), meta: { title: '试玩' } },
    { path: '/secrets', name: 'secrets', component: () => import('./views/Secrets.vue'), meta: { title: '密钥' } },
    { path: '/raw', name: 'raw', component: () => import('./views/RawYaml.vue'), meta: { title: '原始 YAML' } },
  ],
});
