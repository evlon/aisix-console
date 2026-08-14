<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Chart from '../components/Chart.vue';

const { t } = useI18n();

// theme colors (match web/src/style.css :root)
const MUTED = '#9aa3b2';
const BORDER = '#2a2f3a';
const ACCENT = '#3b82f6';
const GREEN = '#22c55e';
const AMBER = '#f59e0b';
const RED = '#ef4444';

const RANGES = ['15m', '1h', '6h', '24h', '7d'];
const range = ref('1h');
const loading = ref(false);
const error = ref(null);
const overview = ref(null);
const summary = ref(null);
const trends = ref({});

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}
function fmtUsd(n) {
  if (n == null) return '—';
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
}
function fmtMs(n) {
  if (n == null) return '—';
  return n + ' ms';
}
function fmtPct(n) {
  if (n == null) return '—';
  return n + '%';
}
function fmtTs(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadAll() {
  loading.value = true;
  error.value = null;
  try {
    const [ov, sm, tr] = await Promise.all([
      api.metricsOverview(),
      api.metricsSummary(range.value),
      api.metricsTrend(range.value, 'requests,tokens_in,tokens_out,spend,latency_p50,latency_p95'),
    ]);
    overview.value = ov;
    summary.value = sm;
    const map = {};
    for (const s of tr.series || []) map[s.name] = s.points;
    trends.value = map;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function onChangeRange(r) {
  range.value = r;
  loadAll();
}

function axis(points) {
  return (points || []).map((p) => new Date(p.ts * 1000).toLocaleTimeString());
}
function vals(points) {
  return (points || []).map((p) => (p.value == null ? null : p.value));
}
function baseGrid() {
  return { left: 56, right: 18, top: 28, bottom: 32 };
}
function baseX(points) {
  return {
    type: 'category',
    data: axis(points),
    axisLabel: { color: MUTED, fontSize: 10 },
    axisLine: { lineStyle: { color: BORDER } },
  };
}
function baseY() {
  return {
    type: 'value',
    axisLabel: { color: MUTED, fontSize: 10 },
    splitLine: { lineStyle: { color: BORDER } },
  };
}
function lineSeries(name, points, color, area) {
  return {
    name,
    type: 'line',
    smooth: true,
    showSymbol: false,
    data: vals(points),
    itemStyle: { color },
    lineStyle: { color, width: 2 },
    areaStyle: area ? { color, opacity: 0.12 } : undefined,
  };
}

const requestsOption = computed(() => ({
  grid: baseGrid(),
  tooltip: { trigger: 'axis' },
  xAxis: baseX(trends.value.requests),
  yAxis: baseY(),
  series: [lineSeries(t('metrics.charts.requests'), trends.value.requests, ACCENT, true)],
}));

const tokensOption = computed(() => ({
  grid: baseGrid(),
  tooltip: { trigger: 'axis' },
  legend: { textStyle: { color: MUTED }, top: 0 },
  xAxis: baseX(trends.value.tokens_in),
  yAxis: baseY(),
  series: [
    lineSeries(t('metrics.kpi.inputTokens'), trends.value.tokens_in, GREEN, true),
    lineSeries(t('metrics.kpi.outputTokens'), trends.value.tokens_out, AMBER, true),
  ],
}));

const spendOption = computed(() => ({
  grid: baseGrid(),
  tooltip: { trigger: 'axis' },
  xAxis: baseX(trends.value.spend),
  yAxis: baseY(),
  series: [lineSeries(t('metrics.charts.spend'), trends.value.spend, ACCENT, true)],
}));

const latencyOption = computed(() => ({
  grid: baseGrid(),
  tooltip: { trigger: 'axis' },
  legend: { textStyle: { color: MUTED }, top: 0 },
  xAxis: baseX(trends.value.latency_p95),
  yAxis: baseY(),
  series: [
    lineSeries('P50', trends.value.latency_p50, GREEN, false),
    lineSeries('P95', trends.value.latency_p95, RED, false),
  ],
}));

const hasData = computed(() => {
  const t0 = summary.value?.totals;
  if (!t0) return false;
  return t0.requests > 0 || t0.totalTokens > 0 || t0.spendUsd > 0;
});

const kpis = computed(() => {
  const x = summary.value?.totals || {};
  return [
    { label: t('metrics.kpi.requests'), value: fmtNum(x.requests) },
    { label: t('metrics.kpi.successRate'), value: fmtPct(x.successRate) },
    { label: t('metrics.kpi.inputTokens'), value: fmtNum(x.inputTokens) },
    { label: t('metrics.kpi.outputTokens'), value: fmtNum(x.outputTokens) },
    { label: t('metrics.kpi.totalTokens'), value: fmtNum(x.totalTokens) },
    { label: t('metrics.kpi.spend'), value: fmtUsd(x.spendUsd) },
    { label: t('metrics.kpi.avgLatency'), value: fmtMs(x.avgLatencyMs) },
    { label: t('metrics.kpi.p95Latency'), value: fmtMs(x.p95LatencyMs) },
    { label: t('metrics.kpi.ttft'), value: fmtMs(x.ttftMs) },
    { label: t('metrics.kpi.inFlight'), value: fmtNum(x.inFlight) },
    { label: t('metrics.kpi.ratelimit'), value: fmtNum(x.ratelimitRejections) },
  ];
});

let timer = null;
function tick() {
  if (!document.hidden) loadAll();
}
function startPolling() {
  if (timer) return;
  timer = setInterval(tick, 15000);
  document.addEventListener('visibilitychange', tick);
}
function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  document.removeEventListener('visibilitychange', tick);
}

onMounted(() => {
  loadAll();
  startPolling();
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <div>
    <!-- range selector -->
    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap">
      <span class="muted">{{ t('metrics.range') }}：</span>
      <button
        v-for="r in RANGES"
        :key="r"
        class="range-btn"
        :class="{ active: range === r }"
        @click="onChangeRange(r)"
      >
        {{ t('metrics.ranges.' + r) }}
      </button>
      <span v-if="loading" class="muted" style="margin-left: auto">{{ t('metrics.loading') }}</span>
    </div>

    <!-- banner: gateway down / scrape failed / scrape info -->
    <div v-if="overview && !overview.reachable" class="error-box">
      {{ t('metrics.gatewayDown') }}
    </div>
    <div v-else-if="overview && !overview.lastScrapeOk" class="warn-box">
      {{ t('metrics.scrapeFailed', { error: overview.lastScrapeError || 'unknown' }) }}
    </div>
    <div v-else-if="overview" class="scrape-info muted">
      {{ t('metrics.scrapeInfo') }}：
      <span class="badge" :class="overview.reachable ? 'ok' : 'err'">{{ overview.reachable ? t('metrics.reachable') : t('metrics.unreachable') }}</span>
      · {{ t('metrics.lastScrape') }}：{{ fmtTs(overview.lastScrapeAt) }}
      · {{ t('metrics.seriesCount') }}：{{ fmtNum(overview.seriesCount) }}
      · {{ t('metrics.retention') }}：{{ overview.retentionDays }}
    </div>
    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="!hasData && !loading && !error" class="warn-box">{{ t('metrics.noData') }}</div>

    <!-- KPI cards -->
    <div class="stat-grid" v-if="hasData">
      <div v-for="k in kpis" :key="k.label" class="stat-card">
        <div class="stat-value">{{ k.value }}</div>
        <div class="stat-label">{{ k.label }}</div>
      </div>
    </div>

    <!-- charts -->
    <div v-if="hasData" class="card">
      <h3 style="margin-top: 0">{{ t('metrics.charts.requests') }}</h3>
      <Chart :option="requestsOption" />
    </div>
    <div v-if="hasData" class="card">
      <h3 style="margin-top: 0">{{ t('metrics.charts.tokens') }}</h3>
      <Chart :option="tokensOption" />
    </div>
    <div v-if="hasData" style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px" class="charts-2col">
      <div class="card">
        <h3 style="margin-top: 0">{{ t('metrics.charts.spend') }}</h3>
        <Chart :option="spendOption" :height="240" />
      </div>
      <div class="card">
        <h3 style="margin-top: 0">{{ t('metrics.charts.latency') }}</h3>
        <Chart :option="latencyOption" :height="240" />
      </div>
    </div>

    <!-- by model -->
    <div v-if="hasData && summary.byModel?.length" class="card">
      <h3 style="margin-top: 0">{{ t('metrics.byModel') }}</h3>
      <table>
        <thead>
          <tr>
            <th>{{ t('metrics.colModel') }}</th>
            <th>{{ t('metrics.colRequests') }}</th>
            <th>{{ t('metrics.colTokens') }}</th>
            <th>{{ t('metrics.colSpend') }}</th>
            <th>{{ t('metrics.colP95') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in summary.byModel" :key="m.model">
            <td>{{ m.model }}</td>
            <td>{{ fmtNum(m.requests) }}</td>
            <td>{{ fmtNum(m.tokens) }}</td>
            <td>{{ fmtUsd(m.spendUsd) }}</td>
            <td>{{ fmtMs(m.p95LatencyMs) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- by key -->
    <div v-if="hasData && summary.byKey?.length" class="card">
      <h3 style="margin-top: 0">{{ t('metrics.byKey') }}</h3>
      <table>
        <thead>
          <tr>
            <th>{{ t('metrics.colKey') }}</th>
            <th>{{ t('metrics.colRequests') }}</th>
            <th>{{ t('metrics.colTokens') }}</th>
            <th>{{ t('metrics.colSpend') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in summary.byKey" :key="k.api_key_id">
            <td>{{ k.api_key_id }}</td>
            <td>{{ fmtNum(k.requests) }}</td>
            <td>{{ fmtNum(k.tokens) }}</td>
            <td>{{ fmtUsd(k.spendUsd) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.range-btn {
  padding: 5px 12px;
  font-size: 13px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: 6px;
  cursor: pointer;
}
.range-btn:hover {
  color: var(--text);
}
.range-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
}
.stat-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
.scrape-info {
  font-size: 12px;
  margin-bottom: 12px;
}
@media (max-width: 720px) {
  .charts-2col {
    grid-template-columns: 1fr !important;
  }
}
</style>
