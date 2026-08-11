<script setup>
import { useStatusStore } from '../stores/status.js';
import { api } from '../api.js';
import { ref } from 'vue';

const status = useStatusStore();

const stateMap = {
  synced: { cls: 'ok', label: '已同步' },
  degraded: { cls: 'warn', label: '降级' },
  out_of_sync: { cls: 'err', label: '失步' },
  empty: { cls: 'warn', label: '空' },
  never_loaded: { cls: 'err', label: '未加载' },
};

const kindLabels = {
  provider_keys: 'Provider Keys',
  models: '模型',
  api_keys: 'API Keys',
  guardrails: '护栏',
  mcp_servers: 'MCP 服务器',
  a2a_agents: 'A2A Agents',
  cache_policies: '缓存策略',
  observability_exporters: '观测导出器',
  rate_limit_policies: '限流策略',
  oidc_providers: 'OIDC',
};

const statusMap = {
  healthy: { cls: 'ok', label: '健康' },
  unhealthy: { cls: 'err', label: '不健康' },
  cooldown: { cls: 'warn', label: '冷却中' },
  not_applicable: { cls: '', label: '不适用' },
};

async function bootstrap() {
  if (!confirm('文件缺失或损坏。要用空模板覆盖创建 resources.yaml 吗？（将丢失现有文件）')) return;
  try {
    const r = await api.bootstrap();
    if (r.ok) {
      alert('已创建空模板，请到各页面添加资源');
      status.refresh();
    } else {
      alert(`创建失败:\n${r.errors.map((e) => `- ${e.message}`).join('\n')}`);
    }
  } catch (e) {
    alert(e.message);
  }
}
</script>

<template>
  <div>
    <div v-if="!status.fileExists" class="warn-box">
      resources.yaml 不存在。请先「创建空模板」，然后在各页面添加配置。
      <button class="primary" style="margin-left: 8px" @click="bootstrap">创建空模板</button>
    </div>
    <div v-else-if="!status.fileOk" class="error-box">
      配置文件解析失败：{{ status.fileError }}。请到「原始 YAML」页修复。
    </div>
    <div v-if="!status.gatewayReachable" class="warn-box">
      网关（metrics :9090）不可达——状态数据不可用；配置管理仍可用，保存不会受影响。
    </div>

    <div class="card">
      <h3 style="margin-top: 0">配置状态</h3>
      <table>
        <tbody>
          <tr>
            <td style="width: 200px" class="muted">配置状态</td>
            <td>
              <span v-if="status.configState" class="badge" :class="stateMap[status.configState]?.cls">
                {{ stateMap[status.configState]?.label }}
              </span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr>
            <td class="muted">上次重载</td>
            <td>
              <template v-if="status.config?.last_reload">
                {{ status.config.last_reload.successful ? '成功' : '失败' }}
                <span class="muted">@ {{ status.config.last_reload.at || '' }}</span>
              </template>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr>
            <td class="muted">配置源</td>
            <td>{{ status.config?.source?.type || '—' }}</td>
          </tr>
          <tr>
            <td class="muted">应用时间</td>
            <td>{{ status.config?.applied?.applied_at || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" v-if="status.config?.rejected?.length">
      <h3 style="margin-top: 0; color: var(--red)">被拒绝的资源</h3>
      <table>
        <thead>
          <tr><th>类型</th><th>ID</th><th>原因</th></tr>
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
      <h3 style="margin-top: 0; color: var(--amber)">部分兼容字段</h3>
      <table>
        <thead>
          <tr><th>类型</th><th>字段</th><th>数量</th></tr>
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
      <h3 style="margin-top: 0">模型健康</h3>
      <table>
        <thead>
          <tr><th>模型</th><th>类型</th><th>状态</th><th>检查结果</th></tr>
        </thead>
        <tbody>
          <tr v-if="!status.modelsHealth.length">
            <td colspan="4" class="muted">暂无数据（网关离线或未配置模型）</td>
          </tr>
          <tr v-for="m in status.modelsHealth" :key="m.id">
            <td>{{ m.display_name }}</td>
            <td>{{ m.kind }}</td>
            <td>
              <span class="badge" :class="statusMap[m.status]?.cls">{{ statusMap[m.status]?.label }}</span>
            </td>
            <td class="muted">{{ m.status_reason || m.last_check_status || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top: 0">资源数量</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px">
        <div v-for="(label, kind) in kindLabels" :key="kind">
          <span class="muted">{{ label }}:</span> {{ status.counts[kind] ?? 0 }}
        </div>
      </div>
    </div>
  </div>
</template>
