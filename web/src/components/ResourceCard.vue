<script setup>
// One card in the resource catalogue: what this resource is for, the count, where
// it is maintained, and the single most expensive mistake specific to it.
//
// The effect and "without it" answers are NOT repeated here. They are the same
// strings the detail page's band shows, one click away, and carrying them on all
// 21 cards made every card 256px tall — a catalogue that is meant to be scanned
// filled three screens. Measured: dropping those two rows takes a card to ~155px.
//
// The "trap" line stays, and stays unclamped: it is one line per kind and not a
// generic "this can fail silently" badge — a marker that appears on every card
// carries no information. The trap text is `resourceCatalog.kind.<key>.trap`.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  kind: { type: String, required: true },
  count: { type: Number, default: 0 },
  // Route of the page that owns this kind, if any (see resourceCatalog.js).
  ownPage: { type: String, default: null },
  // That page's display name (resolved by the caller from `app.nav.*`, since
  // the page name is not the resource name).
  ownPageName: { type: String, default: '' },
  rawOnly: { type: Boolean, default: false },
});

defineEmits(['open']);

const { t, te } = useI18n();

const base = computed(() => `resourceCatalog.kind.${props.kind}`);
const txt = (suffix) => {
  const key = `${base.value}.${suffix}`;
  return te(key) ? t(key) : '';
};
</script>

<template>
  <article class="rcard" @click="$emit('open')">
    <div class="top">
      <span class="name">{{ txt('label') }}</span>
      <span v-if="count > 0" class="badge ok">{{ t('resourceCatalog.statusCount', { n: count }) }}</span>
      <span v-else class="badge plain">{{ t('resourceCatalog.statusUnset') }}</span>
    </div>

    <p class="one">{{ txt('oneLiner') }}</p>

    <dl v-if="txt('trap')" class="fact">
      <dt>{{ t('resourceCatalog.trapLabel') }}</dt>
      <dd class="trap">{{ txt('trap') }}</dd>
    </dl>

    <div class="foot">
      <span class="muted">
        <template v-if="ownPage">{{ t('resourceCatalog.ownedElsewhere', { page: ownPageName }) }}</template>
        <template v-else>{{ t('resourceCatalog.ownedHere') }}</template>
        <span v-if="rawOnly" class="badge plain raw">{{ t('resourceCatalog.rawOnlyBadge') }}</span>
      </span>
      <span class="go">{{ t(ownPage ? 'resourceCatalog.goTo' : 'resourceCatalog.manage') }} →</span>
    </div>
  </article>
</template>

<style scoped>
.rcard {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  cursor: pointer;
}
.rcard:hover {
  border-color: #3d4657;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.name {
  font-weight: 600;
}
.one {
  color: var(--muted);
  margin: 5px 0 8px;
}
.fact {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  font-size: 13px;
  align-items: start;
  margin: 0;
}
.fact dt {
  color: var(--muted);
  margin: 0;
  white-space: nowrap;
}
.fact dd {
  margin: 0;
}
.trap {
  color: #fcd34d;
}
.foot {
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.go {
  color: var(--accent);
  white-space: nowrap;
}
.raw {
  padding: 1px 6px;
  margin-left: 6px;
}
</style>
