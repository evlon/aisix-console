<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import RawYamlEditor from '../components/RawYamlEditor.vue';
import ResourceFacts from '../components/ResourceFacts.vue';
import { stringify as stringifyYaml } from 'yaml';

const { t, te } = useI18n();

// The one label on this page that still showed the configuration key. Same
// resolution chain as the rest of the console: per-kind override, shared field.*,
// then the table-column label.
const FL = (kind, field) => {
  const keys = [
    `resourceCatalog.kind.${kind}.field.${field}`,
    `resourceCatalog.field.${field}`,
    `resourceCatalog.col.${field}`,
  ];
  for (const key of keys) if (te(key)) return t(key);
  return field;
};

const FH = (kind, field) => {
  for (const key of [`resourceCatalog.kind.${kind}.fieldHelp.${field}`, `resourceCatalog.fieldHelp.${field}`]) {
    if (te(key)) return t(key);
  }
  return '';
};
const entries = ref([]);
const providerKeys = ref([]);
const allModels = ref([]); // all model display_names (for target dropdowns)
const loading = ref(false);
const editing = ref(null);
const saving = ref(false);
const lastResult = ref(null);
const tab = ref('form'); // 'form' | 'raw'
const providerModels = ref([]); // real model ids fetched from the selected provider
const providerModelsState = ref(''); // '' | 'loading' | 'ok' | 'empty' | 'error'
const providerModelsMsg = ref('');

const emptyForm = () => ({
  display_name: '',
  // What the user is trying to do. The first question in the form, because the
  // four shapes below are the CONFIG's vocabulary — someone arriving here with a
  // goal ("a cheap main model that falls back") does not think in those terms,
  // and the choice is irreversible in practice: pick the wrong shape and every
  // field afterwards can still be filled in correctly and save cleanly.
  purpose: 'direct',
  shape: 'direct',
  direct: {
    provider: 'openai',
    model_name: '',
    provider_key: '',
    auto_prompt_caching: false,
    // aisix >=1.1.0 direct-model extras (JSON text boxes; empty = omit)
    embedding_text: '',
    background_model_check_text: '',
    effort_mapping_text: '',
    pricing_key: '',
  },
  routing: {
    strategy: 'failover',
    targets: [{ model: '', weight: '', tags: '' }],
    retries: '',
    max_fallbacks: '',
    retry_on_429: false,
    fallback_on_statuses: '',
    // Left to the gateway unless the user picks one: a create that writes a value
    // nobody chose is the same defect as an inspection that does.
    when_all_unavailable: '',
    sticky: false,
  },
  ensemble: {
    panel: [{ model: '', temperature: '', seed: '', weight: '' }],
    judge: { model: '', synthesis_prompt: '' },
    min_responses: '',
  },
  semantic: {
    embedding_model: '',
    match_threshold: '',
    routes: [{ name: '', target: '', description: '', examples: '', threshold: '' }],
    default: '',
    on_embedding_failure: '',
  },
  common: {
    timeout: '',
    stream_timeout: '',
    retries: '',
    rps: '', rpm: '', rph: '', rpd: '', tpm: '', tpd: '', concurrency: '',
    allowed_cidrs: '',
    cost_input: '', cost_output: '',
    cooldown: false,
  },
});

const form = ref(emptyForm());

const strategyOptions = ['round_robin', 'consistent_hash', 'failover', 'least_cost', 'least_latency', 'least_busy'];
const shapeLabels = {
  direct: () => t('models.shapeDirect'),
  routing: () => t('models.shapeRouting'),
  ensemble: () => t('models.shapeEnsemble'),
  semantic: () => t('models.shapeSemantic'),
};
const shapeKeys = { direct: 'shapeDirect', routing: 'shapeRouting', ensemble: 'shapeEnsemble', semantic: 'shapeSemantic' };

// Purpose -> shape. The fifth entry is the reason this table is not a rename of
// the four shapes: an embedding model IS a direct model carrying an `embedding`
// block (the schema requires `dimensions` in it), but "I want an embedding
// model" is a purpose in its own right. Exposing only the four shapes made that
// user pick `direct` and then find a JSON box labelled with a configuration key.
const PURPOSES = [
  { key: 'direct', shape: 'direct' },
  { key: 'routing', shape: 'routing' },
  { key: 'ensemble', shape: 'ensemble' },
  { key: 'semantic', shape: 'semantic' },
  { key: 'embedding', shape: 'direct' },
];
const purposeKeys = {
  direct: 'purposeDirect',
  routing: 'purposeRouting',
  ensemble: 'purposeEnsemble',
  semantic: 'purposeSemantic',
  embedding: 'purposeEmbedding',
};

// An existing entry's purpose, derived the same way its shape is.
const detectPurpose = (e) => {
  if (e?.embedding) return 'embedding';
  return detectShape(e);
};

// Recommended upstream timeouts (ms) per model shape. Routing/failover needs a
// SHORT request timeout so a hung upstream falls back quickly instead of
// blocking on the gateway default (100 minutes); other shapes get a normal
// LLM-generation budget.
const RECOMMENDED_TIMEOUTS = {
  direct: { timeout: 120000, stream: 60000 },
  routing: { timeout: 30000, stream: 20000 },
  ensemble: { timeout: 120000, stream: 60000 },
  semantic: { timeout: 120000, stream: 60000 },
};
const recTimeouts = computed(() => RECOMMENDED_TIMEOUTS[form.value.shape] ?? RECOMMENDED_TIMEOUTS.direct);

// Whether the user has touched the timeout fields in this form. The recommended
// values have to be replaced when the shape changes — routing needs a SHORT
// request timeout so a hung upstream falls back instead of blocking for minutes —
// but a value the user typed must never be overwritten. "Is the field non-empty"
// cannot tell those apart: openCreate fills it, so switching to routing right
// after creating a model kept the direct-shape 120s timeout, which is exactly the
// value the recommendation exists to avoid.
const touchedTimeouts = ref(false);

function fillRecommendedTimeouts() {
  form.value.common.timeout = recTimeouts.value.timeout;
  form.value.common.stream_timeout = recTimeouts.value.stream;
}

// Pre-fill the recommended timeouts only in response to the user CHOOSING a shape
// or purpose — never because a form was opened.
//
// This was a watcher on form.shape, and openEdit assigns form.shape, so merely
// opening a routing model for a look and pressing save wrote a 30s timeout and
// (via when_all_unavailable below) `fail` into the file. Nobody chose those
// values and nothing said they had been written: an inspection changed runtime
// behaviour. The 「推荐值」 button next to the timeout row is the user-driven path
// this was always meant to be.
function chooseShape(next) {
  form.value.shape = next;
  if (!touchedTimeouts.value) fillRecommendedTimeouts();
}

// Fetch the selected provider's real upstream models (GET {api_base}/models)
// so model_name can be picked from a list instead of typed. Falls back to
// free text whenever the provider has no /models endpoint or rejects us.
async function fetchProviderModels() {
  const name = form.value.direct.provider_key;
  if (!name) {
    providerModels.value = [];
    providerModelsState.value = '';
    providerModelsMsg.value = '';
    return;
  }
  providerModelsState.value = 'loading';
  providerModelsMsg.value = '';
  try {
    const r = await api.listProviderModels(name);
    if (r.ok && r.models?.length) {
      providerModels.value = r.models;
      providerModelsState.value = 'ok';
    } else if (r.ok) {
      providerModels.value = [];
      providerModelsState.value = 'empty';
    } else {
      providerModels.value = [];
      providerModelsState.value = 'error';
      providerModelsMsg.value = r.error || '';
    }
  } catch (e) {
    providerModels.value = [];
    providerModelsState.value = 'error';
    providerModelsMsg.value = e.message;
  }
}

watch(
  () => form.value.direct.provider_key,
  () => {
    if (form.value.shape === 'direct') fetchProviderModels();
  },
);

async function load() {
  loading.value = true;
  try {
    const [m, pk] = await Promise.all([api.list('models'), api.list('provider_keys')]);
    entries.value = m.entries ?? [];
    providerKeys.value = pk.entries ?? [];
    allModels.value = (m.entries ?? []).map((e) => e.display_name).filter(Boolean);
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function detectShape(e) {
  if (e.routing) return 'routing';
  if (e.ensemble) return 'ensemble';
  if (e.semantic) return 'semantic';
  return 'direct';
}

function openCreate() {
  form.value = emptyForm();
  touchedTimeouts.value = false;
  fillRecommendedTimeouts(); // pre-fill the direct-shape recommended values
  editing.value = {};
  lastResult.value = null;
  tab.value = 'form';
}

function openEdit(e) {
  const f = emptyForm();
  touchedTimeouts.value = false;
  const shape = detectShape(e);
  f.display_name = e.display_name ?? '';
  f.shape = shape;
  f.purpose = detectPurpose(e);
  f.direct = {
    provider: e.provider ?? 'openai',
    model_name: e.model_name ?? '',
    provider_key: e.provider_key ?? e.provider_key_id ?? '',
    auto_prompt_caching: !!e.auto_prompt_caching,
    embedding_text: e.embedding ? JSON.stringify(e.embedding, null, 2) : '',
    background_model_check_text: e.background_model_check ? JSON.stringify(e.background_model_check, null, 2) : '',
    effort_mapping_text: e.effort_mapping ? JSON.stringify(e.effort_mapping, null, 2) : '',
    pricing_key: e.pricing_key ?? '',
  };
  const r = e.routing || {};
  f.routing = {
    strategy: r.strategy ?? 'failover',
    targets: (r.targets ?? []).map((x) => ({
      model: x.model ?? '',
      weight: x.weight ?? '',
      tags: (x.tags ?? []).join(','),
    })),
    retries: r.retries ?? '',
    max_fallbacks: r.max_fallbacks ?? '',
    retry_on_429: !!r.retry_on_429,
    fallback_on_statuses: (r.fallback_on_statuses ?? []).join(','),
    when_all_unavailable: r.when_all_unavailable ?? '',
    sticky: !!r.sticky,
  };
  const en = e.ensemble || {};
  f.ensemble = {
    panel: (en.panel ?? []).map((p) => ({
      model: p.model ?? '',
      temperature: p.temperature ?? '',
      seed: p.seed ?? '',
      weight: p.weight ?? '',
    })),
    judge: { model: en.judge?.model ?? '', synthesis_prompt: en.judge?.synthesis_prompt ?? '' },
    min_responses: en.min_responses ?? '',
  };
  const s = e.semantic || {};
  f.semantic = {
    embedding_model: s.embedding_model ?? '',
    match_threshold: s.match?.threshold ?? '',
    routes: (s.routes ?? []).map((x) => ({
      name: x.name ?? '',
      target: x.target ?? '',
      description: x.description ?? '',
      examples: (x.examples ?? []).join(' | '),
      threshold: x.threshold ?? '',
    })),
    default: s.default ?? '',
    on_embedding_failure: typeof s.on_embedding_failure === 'string' ? s.on_embedding_failure : s.on_embedding_failure?.target || '',
  };
  const rl = e.rate_limit || {};
  f.common = {
    timeout: e.timeout ?? '',
    stream_timeout: e.stream_timeout ?? '',
    retries: e.retries ?? '',
    rps: rl.rps ?? '', rpm: rl.rpm ?? '', rph: rl.rph ?? '', rpd: rl.rpd ?? '',
    tpm: rl.tpm ?? '', tpd: rl.tpd ?? '', concurrency: rl.concurrency ?? '',
    allowed_cidrs: (e.allowed_cidrs ?? []).join(','),
    cost_input: e.cost?.input_per_1k ?? '',
    cost_output: e.cost?.output_per_1k ?? '',
    cooldown: !!e.cooldown,
  };
  form.value = f;
  editing.value = e;
  lastResult.value = null;
  tab.value = 'form';
}

const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
const strArr = (v) =>
  String(v || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
function parseJsonObj(text, label) {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

function buildEntry() {
  const f = form.value;
  const c = f.common;
  const isEdit = !!editing.value?.display_name;
  const entry = { display_name: f.display_name };

  // A save can change a model's SHAPE. The server now merges (it used to replace
  // the row wholesale, which silently deleted the fields the form does not
  // model), so the shapes this save does not use have to be removed explicitly —
  // otherwise the previous shape survives alongside the new one and the
  // gateway's oneOf rejects the row.
  if (isEdit) {
    for (const shape of ['routing', 'ensemble', 'semantic']) {
      if (f.shape !== shape) entry[shape] = null;
    }
    if (f.shape !== 'direct') {
      // The direct shape's required trio. Both spellings: the form sends the v1
      // name and the console rewrites it to the id field, so nulling only one
      // can leave the stored id behind.
      entry.provider = null;
      entry.model_name = null;
      entry.provider_key = null;
      entry.provider_key_id = null;
    }
  }

  const rl = {};
  for (const k of ['rps', 'rpm', 'rph', 'rpd', 'tpm', 'tpd', 'concurrency']) {
    const v = num(c[k]);
    if (v !== undefined) rl[k] = v;
  }
  if (Object.keys(rl).length) entry.rate_limit = rl;
  const timeout = num(c.timeout);
  if (timeout !== undefined) entry.timeout = timeout;
  const st = num(c.stream_timeout);
  if (st !== undefined) entry.stream_timeout = st;
  const retries = num(c.retries);
  if (retries !== undefined) entry.retries = retries;
  const cidrs = strArr(c.allowed_cidrs);
  if (cidrs.length) entry.allowed_cidrs = cidrs;
  const ci = num(c.cost_input);
  const co = num(c.cost_output);
  if (ci !== undefined || co !== undefined) {
    entry.cost = {};
    if (ci !== undefined) entry.cost.input_per_1k = ci;
    if (co !== undefined) entry.cost.output_per_1k = co;
  }

  if (f.shape === 'direct') {
    entry.provider = f.direct.provider;
    entry.model_name = f.direct.model_name;
    entry.provider_key = f.direct.provider_key;
    if (f.direct.auto_prompt_caching) entry.auto_prompt_caching = { enabled: true };
    if (c.cooldown) entry.cooldown = { enabled: true };
    if (f.direct.pricing_key) entry.pricing_key = f.direct.pricing_key;
    // JSON text boxes — parse and attach when non-empty (empty = omit, so
    // editing never drops a field the form does not model).
    const emb = parseJsonObj(f.direct.embedding_text, 'embedding');
    // `embedding` is what makes a direct model an embedding model, and the schema
    // requires `dimensions` inside it. Both directions are refused here rather
    // than left to mean something:
    //   * chosen the embedding purpose but left the box empty — the choice would
    //     be silently dropped and a plain direct model saved instead;
    //   * a block without dimensions — the gateway rejects the row.
    if (f.purpose === 'embedding' && emb === undefined) throw new Error(t('models.embeddingRequired'));
    if (emb !== undefined && (emb === null || typeof emb !== 'object' || emb.dimensions === undefined)) {
      throw new Error(t('models.embeddingDimensionsRequired'));
    }
    if (emb !== undefined) entry.embedding = emb;
    const bmc = parseJsonObj(f.direct.background_model_check_text, 'background_model_check');
    if (bmc !== undefined) entry.background_model_check = bmc;
    const em = parseJsonObj(f.direct.effort_mapping_text, 'effort_mapping');
    if (em !== undefined) entry.effort_mapping = em;
  } else if (f.shape === 'routing') {
    const r = f.routing;
    const targets = r.targets
      .filter((x) => x.model)
      .map((x) => {
        const o = { model: x.model };
        if (x.weight !== '') o.weight = Number(x.weight);
        if (x.tags) o.tags = strArr(x.tags);
        return o;
      });
    if (!targets.length) throw new Error(t('models.routingTargetRequired'));
    entry.routing = { strategy: r.strategy, targets };
    if (r.retries !== '') entry.routing.retries = Number(r.retries);
    if (r.max_fallbacks !== '') entry.routing.max_fallbacks = Number(r.max_fallbacks);
    if (r.retry_on_429) entry.routing.retry_on_429 = true;
    const fb = strArr(r.fallback_on_statuses);
    if (fb.length) entry.routing.fallback_on_statuses = fb;
    // Only when it is actually set. Omitting it keeps whatever the entry had
    // (the server merges), so opening a routing model that never had this field
    // and saving it leaves the file as it was.
    if (r.when_all_unavailable) entry.routing.when_all_unavailable = r.when_all_unavailable;
  } else if (f.shape === 'ensemble') {
    const en = f.ensemble;
    const panel = en.panel
      .filter((p) => p.model)
      .map((p) => {
        const o = { model: p.model };
        if (p.temperature !== '') o.temperature = Number(p.temperature);
        if (p.seed !== '') o.seed = Number(p.seed);
        if (p.weight !== '') o.weight = Number(p.weight);
        return o;
      });
    if (!panel.length) throw new Error(t('models.ensemblePanelRequired'));
    entry.ensemble = { panel };
    if (en.judge.model) {
      const judge = { model: en.judge.model };
      if (en.judge.synthesis_prompt) judge.synthesis_prompt = en.judge.synthesis_prompt;
      entry.ensemble.judge = judge;
    }
    if (en.min_responses !== '') entry.ensemble.min_responses = Number(en.min_responses);
  } else if (f.shape === 'semantic') {
    const s = f.semantic;
    const routes = s.routes
      .filter((x) => x.name && x.target)
      .map((x) => {
        const o = { name: x.name, target: x.target };
        if (x.description) o.description = x.description;
        const ex = strArr(x.examples);
        if (ex.length) o.examples = ex;
        if (x.threshold !== '') o.threshold = Number(x.threshold);
        return o;
      });
    if (!routes.length) throw new Error(t('models.semanticRouteRequired'));
    entry.semantic = { embedding_model: s.embedding_model, routes };
    if (s.default) entry.semantic.default = s.default;
    if (s.match_threshold !== '') entry.semantic.match = { threshold: Number(s.match_threshold) };
    if (s.on_embedding_failure) entry.semantic.on_embedding_failure = s.on_embedding_failure;
  }

  return entry;
}

const previewYaml = computed(() => {
  try {
    return stringifyYaml(buildEntry(), { lineWidth: 0 });
  } catch (e) {
    return `# ${e.message}`;
  }
});

async function save() {
  if (!form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: t('common.required') }] };
    return;
  }
  let entry;
  try {
    entry = buildEntry();
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
    return;
  }
  saving.value = true;
  try {
    const isEdit = !!editing.value?.display_name;
    const result = isEdit
      ? await api.update('models', editing.value.display_name, entry)
      : await api.create('models', entry);
    lastResult.value = result;
    if (result.ok) {
      editing.value = null;
      await load();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function remove(e) {
  if (!confirm(t('models.deleteConfirm', { name: e.display_name }))) return;
  try {
    const r = await api.remove('models', e.display_name);
    lastResult.value = r;
    if (r.ok) await load();
  } catch (err) {
    lastResult.value = { ok: false, errors: [{ message: err.message }] };
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="lastResult && !lastResult.ok" class="error-box">
      <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
    </div>

    <!-- The same six questions every resource answers, from the same copy the
         catalogue uses. -->
    <ResourceFacts kind="models" />

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <h3 style="margin: 0">{{ t('models.title') }}</h3>
        <button class="primary" @click="openCreate">+ {{ t('common.add') }}</button>
      </div>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>{{ t('common.name') }}</th><th>{{ t('models.colType') }}</th><th>{{ t('models.colTarget') }}</th><th>{{ t('common.actions') }}</th></tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td colspan="4" class="muted">{{ t('models.empty') }}</td>
          </tr>
          <tr v-for="e in entries" :key="e.display_name">
            <td>{{ e.display_name }}</td>
            <td><span class="badge">{{ t('models.' + shapeKeys[detectShape(e)]) }}</span></td>
            <td class="muted">
              <template v-if="e.routing">{{ e.routing.strategy }} → {{ e.routing.targets.map((x) => x.model).join(', ') }}</template>
              <template v-else-if="e.ensemble">{{ e.ensemble.panel.map((p) => p.model).join(', ') }} ({{ t('models.shapeEnsemble') }})</template>
              <template v-else-if="e.semantic">{{ e.semantic.routes.map((x) => x.name).join(', ') }} ({{ t('models.shapeSemantic') }})</template>
              <template v-else>{{ e.provider }} / {{ e.model_name }}</template>
            </td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">{{ t('common.edit') }}</button>
              <button class="danger" @click="remove(e)">{{ t('common.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="editing.display_name ? t('models.edit', { name: editing.display_name }) : t('models.add')" @close="editing = null">
      <div style="margin-bottom: 12px">
        <button v-for="s in ['form', 'raw']" :key="s" :class="{ primary: tab === s }" style="margin-right: 6px" @click="tab = s">
          {{ s === 'form' ? t('models.tabForm') : t('models.tabRaw') }}
        </button>
      </div>

      <template v-if="tab === 'form'">
        <div class="form-row">
          <label>{{ t('common.name') }} *</label>
          <input v-model="form.display_name" :placeholder="t('models.upstreamModel')" />
        </div>
        <!-- Asked first, in the user's terms. The shape below is the same choice
             named the way the configuration names it, kept visible so nobody has
             to open the raw YAML to find out what this model actually is. -->
        <div class="form-row">
          <label>{{ t('models.purpose') }}</label>
          <select
            v-model="form.purpose"
            @change="chooseShape((PURPOSES.find((p) => p.key === form.purpose) || {}).shape || 'direct')"
          >
            <option v-for="p in PURPOSES" :key="p.key" :value="p.key">{{ t('models.' + purposeKeys[p.key]) }}</option>
          </select>
          <p class="fh">{{ t('models.purposeHint') }}</p>
        </div>
        <div class="form-row">
          <label>{{ t('models.shape') }}</label>
          <select
            v-model="form.shape"
            @change="form.purpose = form.shape === 'direct' && (form.direct.embedding_text || '').trim() ? 'embedding' : form.shape; chooseShape(form.shape)"
          >
            <option v-for="(k, val) in shapeKeys" :key="val" :value="val">{{ t('models.' + k) }}</option>
          </select>
        </div>

        <!-- direct -->
        <template v-if="form.shape === 'direct'">
          <div class="form-row">
            <label>{{ t('models.provider') }}</label>
            <input v-model="form.direct.provider" placeholder="openai / deepseek / ..." />
          </div>
          <div class="form-row">
            <label>{{ t('models.upstreamModel') }}</label>
            <div style="flex: 1">
              <div style="display: flex; gap: 6px">
                <input v-model="form.direct.model_name" list="provider-model-list" placeholder="gpt-4o-mini" style="flex: 1" />
                <button :disabled="providerModelsState === 'loading'" @click="fetchProviderModels()">{{ t('models.modelListPull') }}</button>
              </div>
              <datalist id="provider-model-list">
                <option v-for="m in providerModels" :key="m" :value="m" />
              </datalist>
              <div v-if="providerModelsState === 'ok'" class="muted" style="font-size: 12px; margin-top: 4px">
                {{ t('models.modelListHint', { n: providerModels.length }) }}
              </div>
              <div v-else-if="providerModelsState === 'empty'" class="muted" style="font-size: 12px; margin-top: 4px">
                {{ t('models.modelListEmpty') }}
              </div>
              <div v-else-if="providerModelsState === 'error'" class="muted" style="font-size: 12px; margin-top: 4px; color: var(--red)">
                {{ t('models.modelListError', { msg: providerModelsMsg }) }}
              </div>
            </div>
          </div>
          <div class="form-row">
            <label>{{ t('models.providerKey') }}</label>
            <select v-model="form.direct.provider_key">
              <option value="">{{ t('models.choose') }}</option>
              <option v-for="p in providerKeys" :key="p.display_name" :value="p.display_name">{{ p.display_name }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('models.autoPromptCache') }}</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.direct.auto_prompt_caching" /> {{ t('models.autoPromptCacheHint') }}</label>
          </div>
          <div class="form-row">
            <label>{{ t('models.cooldown') }}</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.common.cooldown" /> {{ t('models.cooldownHint') }}</label>
          </div>
          <details style="margin-top: 10px">
            <summary>{{ t('models.advanced') }}</summary>
            <div class="form-row">
              <label>{{ FL('models', 'embedding') }}</label>
              <textarea v-model="form.direct.embedding_text" rows="2" style="flex: 1" placeholder='{"dimensions": 1536, "normalize": true}' />
              <p v-if="FH('models', 'embedding')" class="fh">{{ FH('models', 'embedding') }}</p>
            </div>
            <div class="form-row">
              <label>{{ FL('models', 'background_model_check') }}</label>
              <textarea v-model="form.direct.background_model_check_text" rows="4" style="flex: 1" placeholder='{"enabled": true, "interval_seconds": 60, …}' />
              <p v-if="FH('models', 'background_model_check')" class="fh">{{ FH('models', 'background_model_check') }}</p>
            </div>
            <div class="form-row">
              <label>{{ FL('models', 'effort_mapping') }}</label>
              <textarea v-model="form.direct.effort_mapping_text" rows="2" style="flex: 1" placeholder='{"*": "high"}' />
              <p v-if="FH('models', 'effort_mapping')" class="fh">{{ FH('models', 'effort_mapping') }}</p>
            </div>
            <div class="form-row">
              <label>{{ FL('models', 'pricing_key') }}</label>
              <input v-model="form.direct.pricing_key" placeholder="shared pricing doc name" />
              <p v-if="FH('models', 'pricing_key')" class="fh">{{ FH('models', 'pricing_key') }}</p>
            </div>
          </details>
        </template>

        <!-- routing -->
        <template v-if="form.shape === 'routing'">
          <div class="form-row">
            <label>{{ t('models.strategy') }}</label>
            <select v-model="form.routing.strategy">
              <option v-for="s in strategyOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="form-row full">
            <label style="text-align: left">{{ t('models.targets') }}</label>
            <div v-for="(x, i) in form.routing.targets" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px; align-items: center">
              <select v-model="x.model" style="flex: 1">
                <option value="">{{ t('models.chooseModel') }}</option>
                <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-model="x.weight" :placeholder="t('models.weight')" style="width: 80px" />
              <input v-model="x.tags" :placeholder="t('models.tagsCsv')" style="width: 140px" />
              <button @click="form.routing.targets.splice(i, 1)">✕</button>
            </div>
            <button @click="form.routing.targets.push({ model: '', weight: '', tags: '' })">{{ t('models.addTarget') }}</button>
          </div>
          <div class="form-row">
            <label>{{ t('models.retries') }}</label>
            <input v-model="form.routing.retries" type="number" placeholder="0" />
          </div>
          <div class="form-row">
            <label>{{ t('models.maxFallbacks') }}</label>
            <input v-model="form.routing.max_fallbacks" type="number" />
          </div>
          <div class="form-row">
            <label>{{ t('models.fallbackStatuses') }}</label>
            <input v-model="form.routing.fallback_on_statuses" :placeholder="t('models.fallbackStatusesPlaceholder')" />
          </div>
          <div class="form-row">
            <label>{{ t('models.whenAllUnavailable') }}</label>
            <select v-model="form.routing.when_all_unavailable">
              <option value="">{{ t('models.gatewayDefault') }}</option>
              <option value="fail">{{ t('models.fail') }}</option>
              <option value="try_anyway">{{ t('models.tryAnyway') }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('models.retry429') }}</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.routing.retry_on_429" /></label>
          </div>
        </template>

        <!-- ensemble -->
        <template v-if="form.shape === 'ensemble'">
          <div class="form-row full">
            <label style="text-align: left">{{ t('models.panel') }}</label>
            <div v-for="(p, i) in form.ensemble.panel" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px; align-items: center">
              <select v-model="p.model" style="flex: 1">
                <option value="">{{ t('models.chooseModel') }}</option>
                <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-model="p.temperature" :placeholder="t('models.tempShort')" style="width: 70px" />
              <input v-model="p.weight" :placeholder="t('models.weight')" style="width: 70px" />
              <button @click="form.ensemble.panel.splice(i, 1)">✕</button>
            </div>
            <button @click="form.ensemble.panel.push({ model: '', temperature: '', seed: '', weight: '' })">{{ t('models.addMember') }}</button>
          </div>
          <div class="form-row">
            <label>{{ t('models.judgeModel') }}</label>
            <select v-model="form.ensemble.judge.model">
              <option value="">{{ t('models.optional') }}</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('models.minResponses') }}</label>
            <input v-model="form.ensemble.min_responses" type="number" :placeholder="t('models.minResponsesPlaceholder')" />
          </div>
        </template>

        <!-- semantic -->
        <template v-if="form.shape === 'semantic'">
          <div class="form-row">
            <label>{{ t('models.embeddingModel') }}</label>
            <select v-model="form.semantic.embedding_model">
              <option value="">{{ t('models.choose') }}</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ t('models.matchThreshold') }}</label>
            <input v-model="form.semantic.match_threshold" type="number" step="0.05" placeholder="0~1" />
          </div>
          <div class="form-row full">
            <label style="text-align: left">{{ t('models.routes') }}</label>
            <div v-for="(r, i) in form.semantic.routes" :key="i" style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 8px">
              <div style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="r.name" :placeholder="t('models.routeName')" style="flex: 1" />
                <select v-model="r.target" style="flex: 1">
                  <option value="">{{ t('models.targetModel') }}</option>
                  <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
                </select>
                <button @click="form.semantic.routes.splice(i, 1)">✕</button>
              </div>
              <input v-model="r.description" :placeholder="t('models.routeDesc')" style="width: 100%; margin-bottom: 6px" />
              <input v-model="r.examples" :placeholder="t('models.routeExamples')" style="width: 100%; margin-bottom: 6px" />
              <input v-model="r.threshold" :placeholder="t('models.routeThreshold')" style="width: 100%" />
            </div>
            <button @click="form.semantic.routes.push({ name: '', target: '', description: '', examples: '', threshold: '' })">{{ t('models.addRoute') }}</button>
          </div>
          <div class="form-row">
            <label>{{ t('models.defaultTarget') }}</label>
            <select v-model="form.semantic.default">
              <option value="">{{ t('models.optional') }}</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </template>

        <hr style="border-color: var(--border); margin: 14px 0" />
        <div class="form-row">
          <label>{{ t('models.timeoutMs') }}</label>
          <div style="display: flex; gap: 6px; align-items: center">
            <input
              v-model="form.common.timeout"
              type="number"
              :placeholder="String(recTimeouts.timeout)"
              style="flex: 1"
              @input="touchedTimeouts = true"
            />
            <button class="ghost" style="white-space: nowrap" @click="fillRecommendedTimeouts">
              {{ t('models.useRecommended') }}
            </button>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('models.streamTimeoutMs') }}</label>
          <input
            v-model="form.common.stream_timeout"
            type="number"
            :placeholder="String(recTimeouts.stream)"
            @input="touchedTimeouts = true"
          />
        </div>
        <div class="muted" style="font-size: 12px; margin-bottom: 8px">
          {{ t('models.timeoutHint', { rec: recTimeouts.timeout, stream: recTimeouts.stream }) }}
        </div>
        <div class="form-row">
          <label>{{ t('models.retry') }}</label>
          <input v-model="form.common.retries" type="number" placeholder="0" />
        </div>
        <div class="form-row full">
          <label style="text-align: left">{{ t('models.rateLimit') }}</label>
          <div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px">
              <input v-model="form.common.rps" :placeholder="t('models.rlRps')" />
              <input v-model="form.common.rpm" :placeholder="t('models.rlRpm')" />
              <input v-model="form.common.rph" :placeholder="t('models.rlRph')" />
              <input v-model="form.common.rpd" :placeholder="t('models.rlRpd')" />
              <input v-model="form.common.tpm" :placeholder="t('models.rlTpm')" />
              <input v-model="form.common.tpd" :placeholder="t('models.rlTpd')" />
              <input
                v-model="form.common.concurrency"
                :placeholder="t('models.rlConcurrency')"
                style="grid-column: 1 / -1"
              />
            </div>
            <div class="muted" style="font-size: 12px; margin-top: 6px">{{ t('models.rateLimitHint') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('models.allowedCidrs') }}</label>
          <input v-model="form.common.allowed_cidrs" placeholder="10.0.0.0/8, ..." />
        </div>
        <div class="form-row">
          <label>{{ t('models.cost') }}</label>
          <div style="display: flex; gap: 6px">
            <input v-model="form.common.cost_input" :placeholder="t('models.costInput')" style="flex: 1" />
            <input v-model="form.common.cost_output" :placeholder="t('models.costOutput')" style="flex: 1" />
          </div>
        </div>
      </template>

      <template v-else>
        <RawYamlEditor :model-value="previewYaml" />
        <div class="muted" style="margin-top: 6px">{{ t('models.rawPreviewHint') }}</div>
      </template>

      <div v-if="lastResult && !lastResult.ok" class="error-box" style="margin-top: 14px">
        <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
        <button @click="editing = null">{{ t('common.cancel') }}</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.saveAndReload') }}</button>
      </div>
      <div v-if="lastResult && lastResult.ok" class="badge ok" style="margin-top: 10px">
        {{ t('common.saved') }}{{ lastResult.reload?.warning ? t('common.sep') + lastResult.reload.warning : '' }}{{ lastResult.notice ? t('common.sep') + lastResult.notice : '' }}
      </div>
    </Modal>
  </div>
</template>

<style scoped>
/* The label column holds Chinese field names and the help sits under the input
   spanning both columns: a 40-character sentence in the label column would wrap
   to four lines and bury the input. */
.modal .form-row {
  grid-template-columns: 200px 1fr;
}

.modal .form-row > .fh {
  grid-column: 2;
  margin: -2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}
</style>