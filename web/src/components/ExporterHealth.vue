<script setup>
// Delivery health for the telemetry fan-out.
//
// This is deliberately a page-level card rather than something inside the edit
// modal: the question it answers — "is anything actually leaving the gateway?"
// — is about the gateway, not about one exporter's field values.
//
// Scope honesty: the shipped gateway exposes only gateway-wide emit/drop
// counters, so per-exporter attribution is feature-detected. When the running
// gateway does not provide it, we say so instead of implying each exporter is
// healthy.
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';

const { t } = useI18n();

const RANGES = ['1h', '6h', '24h'];
const range = ref('1h');
const data = ref(null);
const error = ref(null);
const loading = ref(false);
const showSnippetsHelp = ref(false);

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}

function fmtTs(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await api.exportersHealth(range.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function setRange(r) {
  range.value = r;
  load();
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <div class="card">
    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
      <h3 style="margin: 0">{{ t('obs.healthTitle') }}</h3>
      <span class="muted" style="font-size: 12px">{{ t('obs.healthSubtitle') }}</span>
      <span style="margin-left: auto; display: flex; gap: 6px">
        <button
          v-for="r in RANGES"
          :key="r"
          :class="{ primary: range === r }"
          style="padding: 3px 10px; font-size: 12px"
          @click="setRange(r)"
        >
          {{ t('metrics.ranges.' + r) }}
        </button>
      </span>
    </div>

    <div v-if="error" class="error-box" style="margin-top: 10px">{{ error }}</div>

    <template v-else-if="data">
      <div v-if="!data.storeReady" class="warn-box" style="margin-top: 10px">
        {{ t('obs.healthNoStore') }}
      </div>
      <div v-else-if="!data.lastScrapeOk" class="warn-box" style="margin-top: 10px">
        {{ t('obs.healthScrapeFailed') }}
      </div>

      <div v-if="data.storeReady" class="health-grid">
        <div class="health-cell">
          <div class="health-value">{{ fmtNum(data.emitted) }}</div>
          <div class="health-label">{{ t('obs.healthEmitted') }}</div>
        </div>
        <div class="health-cell">
          <div class="health-value" :style="data.drops > 0 ? 'color: var(--amber)' : ''">
            {{ fmtNum(data.drops) }}
          </div>
          <div class="health-label">{{ t('obs.healthDrops') }}</div>
        </div>
        <div class="health-cell">
          <div class="health-value" :style="data.dropRate > 0 ? 'color: var(--amber)' : ''">
            {{ data.dropRate == null ? '—' : data.dropRate + '%' }}
          </div>
          <div class="health-label">{{ t('obs.healthDropRate') }}</div>
        </div>
        <div class="health-cell">
          <div class="health-value" style="font-size: 13px">{{ fmtTs(data.lastScrapeAt) }}</div>
          <div class="health-label">{{ t('obs.healthLastScrape') }}</div>
        </div>
      </div>

      <!-- per-exporter attribution, when the gateway version provides it -->
      <template v-if="data.storeReady">
        <div v-if="data.perExporterSupported" style="margin-top: 12px">
          <table>
            <thead>
              <tr>
                <th>{{ t('obs.colExporter') }}</th>
                <th>{{ t('obs.healthDrops') }}</th>
                <th>{{ t('obs.healthFailures') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!data.perExporter?.length">
                <td colspan="3" class="muted">{{ t('obs.healthNoPerExporterRows') }}</td>
              </tr>
              <tr v-for="r in data.perExporter" :key="r.exporter">
                <td>{{ r.exporter }}</td>
                <td>{{ fmtNum(r.drops) }}</td>
                <td>{{ fmtNum(r.failures) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted" style="font-size: 12px; margin-top: 12px">
          {{ t('obs.healthGlobalOnly') }}
        </p>

        <div v-if="data.dropsByReason?.length" style="margin-top: 10px">
          <div class="muted" style="font-size: 12px; margin-bottom: 4px">{{ t('obs.healthDropsByReason') }}</div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap">
            <span v-for="r in data.dropsByReason" :key="r.key" class="badge err">
              {{ r.key }} · {{ fmtNum(r.value) }}
            </span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-top: 12px;
}
.health-cell {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.health-value {
  font-size: 20px;
  font-weight: 700;
}
.health-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}
</style>
