<script setup>
// The fixed six questions every resource answers, in the same order, so a user
// knows where to look instead of re-reading a different layout per kind.
//
// The copy comes from `resourceCatalog.kind.<key>.*`; the structure (which
// relations exist, which failure modes apply) comes from
// web/src/lib/resourceCatalog.js. `te()` guards the optional ones — rendering a
// missing key would show the user a raw dotted path.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MIS_MODES, RELATIONS } from '../lib/resourceCatalog.js';

const props = defineProps({
  kind: { type: String, required: true },
  rawOnly: { type: Boolean, default: false },
});

const { t, te } = useI18n();

const base = computed(() => `resourceCatalog.kind.${props.kind}`);
const kindKey = (key, suffix) => `resourceCatalog.kind.${key}.${suffix}`;
const txt = (suffix) => {
  const key = `${base.value}.${suffix}`;
  return te(key) ? t(key) : null;
};

const relations = computed(() =>
  (RELATIONS[props.kind] ?? []).map((r) => ({
    key: `${r.from}.${r.field}`,
    text: t(r.by === 'id' ? 'resourceCatalog.relById' : 'resourceCatalog.relByName', {
      from: t(kindKey(r.from, 'label')),
      field: r.field,
    }),
  }))
);

// The gateway reacts to a bad resource in exactly three ways, and they are not
// equally visible: `file` stops the gateway coming up, `row` drops just this
// row and shows up in /status/config, and `silent` does nothing at all. That
// last one is why this band exists.
const misconfig = computed(() =>
  (MIS_MODES[props.kind] ?? []).map((mode, i) => ({
    mode,
    label: t(`resourceCatalog.fail.${mode}.label`),
    cls: mode === 'file' ? 'err' : mode === 'row' ? 'warn' : 'plain',
    text: t(`${base.value}.mis.${i}`),
  }))
);
</script>

<template>
  <dl class="facts card">
    <div class="row">
      <dt>{{ t('resourceCatalog.factWhat') }}</dt>
      <dd>{{ txt('oneLiner') }}</dd>
    </div>
    <div class="row">
      <dt>{{ t('resourceCatalog.factWhen') }}</dt>
      <dd>{{ txt('whenNeeded') }}</dd>
    </div>
    <div class="row">
      <dt>{{ t('resourceCatalog.factEffect') }}</dt>
      <dd>{{ txt('effect') }}</dd>
    </div>
    <div class="row">
      <dt>{{ t('resourceCatalog.factAbsent') }}</dt>
      <dd>{{ txt('ifAbsent') }}</dd>
    </div>
    <div class="row">
      <dt>{{ t('resourceCatalog.factLinks') }}</dt>
      <dd>
        <div v-for="r in relations" :key="r.key">· {{ r.text }}</div>
        <span v-if="!relations.length" class="muted">{{ t('resourceCatalog.noRelation') }}</span>
      </dd>
    </div>
    <div v-if="misconfig.length" class="row">
      <dt>{{ t('resourceCatalog.factMis') }}</dt>
      <dd>
        <div v-for="(m, i) in misconfig" :key="i" class="mis">
          <span class="badge" :class="m.cls">{{ m.label }}</span>
          <span>{{ m.text }}</span>
        </div>
      </dd>
    </div>
    <div v-if="txt('verify')" class="row">
      <dt>{{ t('resourceCatalog.factVerify') }}</dt>
      <dd><code>{{ txt('verify') }}</code></dd>
    </div>
    <div v-if="rawOnly" class="row">
      <dt>{{ t('resourceCatalog.factRawOnly') }}</dt>
      <dd class="muted">{{ t('resourceCatalog.rawOnlyNote') }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.facts {
  padding: 4px 16px;
  margin-bottom: 16px;
}
.row {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 8px 14px;
  padding: 9px 0;
}
.row + .row {
  border-top: 1px solid var(--border);
}
dt {
  color: var(--muted);
  font-size: 13px;
}
dd {
  margin: 0;
}
.mis {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.mis:last-child {
  margin-bottom: 0;
}
.mis .badge {
  flex: 0 0 108px;
  text-align: center;
}
code {
  word-break: break-all;
}
</style>
