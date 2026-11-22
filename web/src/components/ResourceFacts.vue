<script setup>
// The fixed six questions every resource answers, in the same order, so a user
// knows where to look instead of re-reading a different layout per kind.
//
// The copy comes from `resourceCatalog.kind.<key>.*`; the structure (which
// relations exist, which failure modes apply) comes from
// web/src/lib/resourceCatalog.js. `te()` guards the optional ones — rendering a
// missing key would show the user a raw dotted path.
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { MIS_MODES, RELATIONS } from '../lib/resourceCatalog.js';

const props = defineProps({
  kind: { type: String, required: true },
  rawOnly: { type: Boolean, default: false },
});

const { t, te } = useI18n();

// Compact by default: one line, the answer to "what is this". Measured before the
// change, the full band was 380px on a 643px viewport — 59% of the screen — which
// pushed the table the operator actually came for below the fold. The other six
// questions are one click away, and the choice is remembered, because someone who
// wants them wants them every time.
const expanded = ref(localStorage.getItem('resourceFactsExpanded') === '1');
function toggle() {
  expanded.value = !expanded.value;
  localStorage.setItem('resourceFactsExpanded', expanded.value ? '1' : '0');
}

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
  <dl class="facts card" :class="{ expanded }">
    <div class="row">
      <dt>{{ t('resourceCatalog.factWhat') }}</dt>
      <dd>
        <span>{{ txt('oneLiner') }}</span>
        <button class="ghost facts-toggle" @click="toggle">
          {{ expanded ? t('resourceCatalog.factsLess') : t('resourceCatalog.factsMore') }}
        </button>
      </dd>
    </div>
    <template v-if="expanded">
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
    </template>
  </dl>
</template>

<style scoped>
.facts {
  padding: 2px 16px;
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
/* Expanded, the seven answers flow into two columns instead of one. Measured, this
   does NOT make the expanded band shorter (383px against 380px) — a couple of the
   answers are tall enough to set the row height, which is what dominates. It is
   here because two columns read better than seven stacked rows, and the height
   that mattered was won by collapsing the band by default, not by this. */
.facts.expanded {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  align-items: start;
  padding-top: 4px;
  padding-bottom: 10px;
}
.facts.expanded .row {
  padding: 7px 0;
}
.facts.expanded .row + .row {
  border-top: none;
}
.facts.expanded .row:not(:first-child) {
  border-top: 1px solid var(--border);
}
.facts-toggle {
  margin-left: 10px;
  padding: 1px 8px;
  font-size: 12px;
  vertical-align: baseline;
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
