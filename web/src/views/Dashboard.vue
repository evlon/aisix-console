<script setup>
import { useI18n } from 'vue-i18n';
import { useStatusStore } from '../stores/status.js';
import { api } from '../api.js';
import { ref } from 'vue';

const status = useStatusStore();
const { t } = useI18n();

const stateMap = {
  synced: { cls: 'ok', label: () => t('dashboard.stateSynced') },
  degraded: { cls: 'warn', label: () => t('dashboard.stateDegraded') },
  out_of_sync: { cls: 'err', label: () => t('dashboard.stateOutOfSync') },
  empty: { cls: 'warn', label: () => t('dashboard.stateEmpty') },
  never_loaded: { cls: 'err', label: () => t('dashboard.stateNeverLoaded') },
};

const kindLabels = {
  provider_keys: () => t('dashboard.kindProviderKeys'),
  models: () => t('dashboard.kindModels'),
  api_keys: () => t('dashboard.kindApiKeys'),
  guardrails: () => t('dashboard.kindGuardrails'),
  mcp_servers: () => t('dashboard.kindMcpServers'),
  a2a_agents: () => t('dashboard.kindA2a'),
  cache_policies: () => t('dashboard.kindCachePolicies'),
  observability_exporters: () => t('dashboard.kindObsExporters'),
  rate_limit_policies: () => t('dashboard.kindRateLimitPolicies'),
  oidc_providers: () => t('dashboard.kindOidc'),
};

const statusMap = {
  healthy: { cls: 'ok', label: () => t('dashboard.healthHealthy') },
  unhealthy: { cls: 'err', label: () => t('dashboard.healthUnhealthy') },
  cooldown: { cls: 'warn', label: () => t('dashboard.healthCooldown') },
  not_applicable: { cls: '', label: () => t('dashboard.healthNa') },
};

async function bootstrap() {
  if (!confirm(t('dashboard.fileMissing') + '\n\n' + t('common.confirm') + '?')) return;
  try {
    const r = await api.bootstrap();
    if (r.ok) {
      alert(t('dashboard.createTemplate') + ' ✓');
      status.refresh();
    } else {
      alert(r.errors.map((e) => `- ${e.message}`).join('\n'));
    }
  } catch (e) {
    alert(e.message);
  }
}
</script>

<template>
  <div>
    <div v-if="!status.fileExists" class="warn-box">
      {{ t('dashboard.fileMissing') }}
      <button class="primary" style="margin-left: 8px" @click="bootstrap">{{ t('dashboard.createTemplate') }}</button>
    </div>
    <div v-else-if="!status.fileOk" class="error-box">
      {{ t('dashboard.fileBroken', { error: status.fileError }) }}
    </div>
    <div v-if="!status.gatewayReachable" class="warn-box">
      {{ t('dashboard.gatewayDown') }}
    </div>

    <div class="card">
      <h3 style="margin-top: 0">{{ t('dashboard.configState') }}</h3>
      <table>
        <tbody>
          <tr>
            <td style="width: 200px" class="muted">{{ t('dashboard.configState') }}</td>
            <td>
              <span v-if="status.configState" class="badge" :class="stateMap[status.configState]?.cls">
                {{ stateMap[status.configState]?.label() }}
              </span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr>
            <td class="muted">{{ t('dashboard.lastReload') }}</td>
            <td>
              <template v-if="status.config?.last_reload">
                {{ status.config.last_reload.successful ? t('dashboard.success') : t('dashboard.failed') }}
                <span class="muted">@ {{ status.config.last_reload.at || '' }}</span>
              </template>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr>
            <td class="muted">{{ t('dashboard.source') }}</td>
            <td>{{ status.config?.source?.type || '—' }}</td>
          </tr>
          <tr>
            <td class="muted">{{ t('dashboard.appliedAt') }}</td>
            <td>{{ status.config?.applied?.applied_at || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" v-if="status.config?.rejected?.length">
      <h3 style="margin-top: 0; color: var(--red)">{{ t('dashboard.rejected') }}</h3>
      <table>
        <thead>
          <tr><th>{{ t('app.nav.providerKeys') }}</th><th>ID</th><th>{{ t('dashboard.reason') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in status.config.rejected" :key="i">
            <td>{{ r.resource_kind }}</td>
            <td>{{ r.resource_id }}</td>
            <td>{{ r.last_error }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" v-if="status.config?.partially_compatible?.length">
      <h3 style="margin-top: 0; color: var(--amber)">{{ t('dashboard.partialCompat') }}</h3>
      <table>
        <thead>
          <tr><th>{{ t('app.nav.providerKeys') }}</th><th>{{ t('dashboard.field') }}</th><th>{{ t('dashboard.count') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in status.config.partially_compatible" :key="i">
            <td>{{ p.resource_kind }}</td>
            <td>{{ p.field }}</td>
            <td>{{ p.count }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top: 0">{{ t('dashboard.modelHealth') }}</h3>
      <table>
        <thead>
          <tr><th>{{ t('app.nav.models') }}</th><th>{{ t('models.colType') }}</th><th>{{ t('common.status') }}</th><th>{{ t('dashboard.checkResult') }}</th></tr>
        </thead>
        <tbody>
          <tr v-if="!status.modelsHealth.length">
            <td colspan="4" class="muted">{{ t('dashboard.noModelData') }}</td>
          </tr>
          <tr v-for="m in status.modelsHealth" :key="m.id">
            <td>{{ m.display_name }}</td>
            <td>{{ m.kind }}</td>
            <td>
              <span class="badge" :class="statusMap[m.status]?.cls">{{ statusMap[m.status]?.label() || m.status }}</span>
            </td>
            <td class="muted">{{ m.status_reason || m.last_check_status || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top: 0">{{ t('dashboard.resourceCounts') }}</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px">
        <div v-for="(label, kind) in kindLabels" :key="kind">
          <span class="muted">{{ label() }}:</span> {{ status.counts[kind] ?? 0 }}
        </div>
      </div>
    </div>
  </div>
</template>
