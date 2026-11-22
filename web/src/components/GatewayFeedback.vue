<script setup>
// The console's missing half of the save loop.
//
// Saving a config change reports "saved" — but the gateway can still drop the
// row (see MIS_MODES in web/src/lib/resourceCatalog.js). It records that in
// GET /status/config as rejected[] / partially_compatible[], which the console
// already fetches (server/src/gateway.js, server/src/routes/status.js) and used
// to show only on the dashboard. This component puts it where the operator is
// actually working, and states plainly that a rejected row had no effect.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  // `config.data` from /api/status — the gateway's /status/config verbatim.
  config: { type: Object, default: null },
  // Total rows in the local file, so the healthy state can say what was loaded.
  rowCount: { type: Number, default: null },
  // Findings from the effect self-check: [{ kind, code, params }]. The copy is
  // ours, keyed by code; the server never sends prose.
  checks: { type: Array, default: () => [] },
});

const { t, te } = useI18n();

// Mirrors the mapping App.vue uses for the sidebar badge, so the two never
// disagree about what a state is called.
const STATE_KEY = {
  synced: 'stateSynced',
  degraded: 'stateDegraded',
  out_of_sync: 'stateOutOfSync',
  empty: 'stateEmpty',
  never_loaded: 'stateNeverLoaded',
};
const STATE_CLS = { synced: 'ok', degraded: 'warn', out_of_sync: 'err', empty: 'warn', never_loaded: 'err' };

const state = computed(() => props.config?.state ?? null);
const rejected = computed(() => props.config?.rejected ?? []);
const partial = computed(() => props.config?.partially_compatible ?? []);
const broken = computed(() => rejected.value.length > 0 || partial.value.length > 0);
// The status route always returns an object — when the gateway is down it is
// `{ reachable: false, error }`, not null. So "do we have a verdict" is the
// presence of a state string, not the presence of the object.
const hasVerdict = computed(() => !!props.config && typeof props.config.state === 'string');

const stateLabel = computed(() => {
  if (state.value === 'synced') return t('dashboard.feedbackSynced');
  const key = STATE_KEY[state.value];
  return key && te(`dashboard.${key}`) ? t(`dashboard.${key}`) : (state.value ?? '—');
});
const stateCls = computed(() => STATE_CLS[state.value] ?? 'plain');

// The gateway reports the collection name (`guardrail_attachments`). Showing
// the label the catalogue uses keeps the row readable, and falls back to the
// raw name for a collection this build predates.
const kindLabel = (kind) => {
  if (!kind) return '—';
  const key = `resourceCatalog.kind.${kind}.label`;
  return te(key) ? t(key) : kind;
};

// The server sends a code plus its parameters; the sentence is ours. A code with
// no copy yet falls back to the code rather than rendering a dotted key path or
// an empty row — the web suite asserts the two halves agree in both directions,
// so this branch should be unreachable, but silence would be the worse failure.
const checkText = (c) => {
  const key = `resourceCatalog.check.${c.code}`;
  return te(key) ? t(key, c.params ?? {}) : c.code;
};
</script>

<template>
  <div>
    <div v-if="broken" class="rejected">
      <strong>{{ t('dashboard.rejectedHeadline', { n: rejected.length + partial.length }) }}</strong>
      <span class="muted"> {{ t('dashboard.rejectedExplain') }}</span>

      <table v-if="rejected.length">
        <thead>
          <tr>
            <th>{{ t('dashboard.resourceKind') }}</th>
            <th>ID</th>
            <th>{{ t('dashboard.reason') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rejected" :key="i">
            <td>{{ kindLabel(r.resource_kind) }}</td>
            <td><code>{{ r.resource_id }}</code></td>
            <td>{{ r.last_error }}</td>
          </tr>
        </tbody>
      </table>

      <table v-if="partial.length" style="margin-top: 10px">
        <thead>
          <tr>
            <th>{{ t('dashboard.resourceKind') }}</th>
            <th>{{ t('dashboard.field') }}</th>
            <th>{{ t('dashboard.count') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in partial" :key="i">
            <td>{{ kindLabel(p.resource_kind) }}</td>
            <td>{{ p.field }}</td>
            <td>{{ p.count }}</td>
          </tr>
        </tbody>
      </table>

      <p class="muted note">{{ t('dashboard.rejectedFixHint') }}</p>
      <p class="muted note">{{ t('dashboard.rejectedSource') }}</p>
    </div>

    <!-- No gateway means no verdict. Saying "this load passed" here would be
         exactly the false reassurance this component exists to remove: the
         console cannot know what the gateway loaded if it cannot ask it. -->
    <div v-else-if="!hasVerdict" class="strip">
      <span class="badge err">{{ t('app.offline') }}</span>
      <span class="muted">{{ t('dashboard.gatewayDown') }}</span>
    </div>

    <div v-else class="strip">
      <span class="badge" :class="stateCls">{{ stateLabel }}</span>
      <span v-if="rowCount !== null" class="muted">{{ t('dashboard.feedbackLoadOk', { n: rowCount }) }}</span>
    </div>

    <details v-if="checks.length" class="checks">
      <summary>{{ t('dashboard.effectChecks') }} · {{ checks.length }}</summary>
      <p class="muted note">{{ t('resourceCatalog.checkIntro') }}</p>
      <div v-for="(c, i) in checks" :key="i" class="check">
        <span class="badge plain">{{ kindLabel(c.kind) }}</span>
        <span>{{ checkText(c) }}</span>
      </div>
    </details>
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}
.rejected {
  border: 1px solid var(--red);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 16px;
  background: rgba(239, 68, 68, 0.06);
}
.rejected table {
  margin-top: 8px;
}
.rejected td,
.rejected th {
  font-size: 13px;
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
}
.checks {
  border: 1px solid var(--amber);
  border-radius: 8px;
  padding: 4px 14px;
  margin-bottom: 16px;
  background: rgba(245, 158, 11, 0.06);
}
.checks summary {
  cursor: pointer;
  padding: 8px 0;
  font-size: 13px;
  color: #fcd34d;
}
.check {
  display: flex;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.check .badge {
  flex: 0 0 auto;
}
</style>
