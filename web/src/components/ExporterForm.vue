<script setup>
// Observability-exporter form — target-oriented, with the gateway-side
// credential chain made visible.
//
// The draft object is mutated in place (the same convention Resources.vue uses
// for its other resource forms), so the parent keeps owning save/validation.
//
// Three things this form does that the previous one did not:
//   1. You pick a DESTINATION (Grafana / Datadog / SLS / object storage), and
//      the kind plus an endpoint template follow from that.
//   2. The credential section derives the exact environment variables the
//      gateway will look for and shows which ones are present. `credential_ref`
//      is a reference NAME, not a secret — the old form gave no hint of that.
//   3. Field constraints are checked in the form, mirroring the gateway's
//      schema regexes, instead of surfacing later as an `aisix validate` error.
import { computed, ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import {
  TARGETS,
  defaultDraft,
  targetForKind,
  validateDraft,
  buildEntry,
  destinationOf,
  DATADOG_SITES,
  DEFAULT_CONTENT_MAX_BYTES,
} from '../lib/exporterTargets.js';

const props = defineProps({
  draft: { type: Object, required: true },
  // The entry being edited, or null when creating. Used only to label the
  // credential section as "already configured" vs "not yet set up".
  original: { type: Object, default: null },
});

const { t } = useI18n();

const targetId = ref(targetForKind(props.draft.kind).id);
const plan = ref(null);
const planError = ref(null);
const showSnippets = ref(false);
const snippetTab = ref('compose');

// Keep the highlighted card in step with the draft kind (e.g. when editing).
watch(
  () => props.draft.kind,
  (k) => {
    const id = targetForKind(k).id;
    if (id !== targetId.value) targetId.value = id;
  },
);

function chooseTarget(target) {
  if (target.id === targetId.value) return;
  targetId.value = target.id;
  const keep = { name: props.draft.name, enabled: props.draft.enabled };
  const fresh = { ...defaultDraft(target.kind), ...keep };
  for (const key of Object.keys(props.draft)) delete props.draft[key];
  Object.assign(props.draft, fresh);
}

const errors = computed(() => validateDraft(props.draft));

function fieldError(field) {
  const key = errors.value[field];
  return key ? t('obs.err.' + key) : '';
}

// ---- credential plan --------------------------------------------------------
let planTimer = null;
async function loadPlan() {
  try {
    const p = await api.exporterCredentialPlan({
      kind: props.draft.kind,
      ref: props.draft.credential_ref || '',
      provider: props.draft.provider || '',
      authMode: props.draft.auth_mode || '',
    });
    plan.value = p;
    planError.value = null;
  } catch (e) {
    planError.value = e.message;
  }
}

function schedulePlan() {
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(loadPlan, 250);
}

watch(
  () => [props.draft.kind, props.draft.credential_ref, props.draft.provider, props.draft.auth_mode],
  schedulePlan,
);

onMounted(loadPlan);

// Whether this kind carries a `content_mode` / `content_max_bytes` pair.
const hasContentMode = computed(() =>
  ['otlp_http', 'aliyun_sls', 'datadog'].includes(props.draft.kind),
);
const needsCredentialRef = computed(() => {
  if (props.draft.kind === 'object_store') return props.draft.auth_mode !== 'cloud_identity';
  return props.draft.kind !== 'otlp_http';
});

// Live "where does it send" preview, built from the same mapper the list uses.
const previewDestination = computed(() => destinationOf(buildEntrySafe()));

function buildEntrySafe() {
  try {
    return buildEntry(props.draft);
  } catch {
    return {};
  }
}

function useDefaultContentBytes() {
  props.draft.content_max_bytes = String(DEFAULT_CONTENT_MAX_BYTES);
}

defineExpose({ errors, reloadPlan: loadPlan });
</script>

<template>
  <div>
    <!-- 1. destination -->
    <div class="obs-step">
      <div class="obs-step-title">{{ t('obs.step1') }}</div>
      <div class="target-grid">
        <button
          v-for="tg in TARGETS"
          :key="tg.id"
          class="target-card"
          :class="{ active: targetId === tg.id }"
          @click="chooseTarget(tg)"
        >
          <div class="target-name">{{ t(tg.labelKey) }}</div>
          <div class="target-desc">{{ t(tg.descKey) }}</div>
        </button>
      </div>
    </div>

    <!-- 2. connection -->
    <div class="obs-step">
      <div class="obs-step-title">{{ t('obs.step2') }}</div>

      <div class="form-row">
        <label>{{ t('obs.fieldName') }} *</label>
        <div class="field-wrap">
          <input v-model="draft.name" :placeholder="t('obs.fieldNamePlaceholder')" />
          <div v-if="fieldError('name')" class="field-error">{{ fieldError('name') }}</div>
        </div>
      </div>

      <!-- OTLP -->
      <template v-if="draft.kind === 'otlp_http'">
        <div class="form-row">
          <label>{{ t('obs.fieldEndpoint') }} *</label>
          <div class="field-wrap">
            <input
              v-model="draft.endpoint"
              :placeholder="TARGETS.find((x) => x.id === targetId)?.endpointPlaceholder"
            />
            <div v-if="fieldError('endpoint')" class="field-error">{{ fieldError('endpoint') }}</div>
            <div v-else class="field-help">{{ t('obs.endpointHelpOtlp') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldHeaders') }}</label>
          <div class="field-wrap">
            <textarea
              v-model="draft.headers_text"
              rows="3"
              placeholder="Authorization: Bearer <你的 token>"
            />
            <div class="field-help">{{ t('obs.headersHelp') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldSampleRate') }}</label>
          <div class="field-wrap">
            <input v-model="draft.sample_rate" type="number" min="0" max="1" step="0.05" placeholder="1" />
            <div v-if="fieldError('sample_rate')" class="field-error">{{ fieldError('sample_rate') }}</div>
            <div v-else class="field-help">{{ t('obs.sampleRateHelp') }}</div>
          </div>
        </div>
      </template>

      <!-- Datadog -->
      <template v-else-if="draft.kind === 'datadog'">
        <div class="form-row">
          <label>{{ t('obs.fieldSite') }} *</label>
          <div class="field-wrap">
            <select v-model="draft.site">
              <option v-for="s in DATADOG_SITES" :key="s" :value="s">{{ s }}</option>
            </select>
            <div v-if="fieldError('site')" class="field-error">{{ fieldError('site') }}</div>
            <div v-else class="field-help">{{ t('obs.siteHelp') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldService') }} *</label>
          <div class="field-wrap">
            <input v-model="draft.service" placeholder="aisix-gateway" />
            <div v-if="fieldError('service')" class="field-error">{{ fieldError('service') }}</div>
            <div v-else class="field-help">{{ t('obs.serviceHelp') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldDdsource') }}</label>
          <div class="field-wrap">
            <input v-model="draft.ddsource" placeholder="aisix-ai-gateway" />
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldTags') }}</label>
          <div class="field-wrap">
            <input v-model="draft.tags_text" placeholder="team:platform, tier:prod" />
            <div class="field-help">{{ t('obs.tagsHelp') }}</div>
          </div>
        </div>
      </template>

      <!-- Aliyun SLS -->
      <template v-else-if="draft.kind === 'aliyun_sls'">
        <div class="form-row">
          <label>{{ t('obs.fieldSlsEndpoint') }} *</label>
          <div class="field-wrap">
            <input v-model="draft.endpoint" placeholder="ap-southeast-3.log.aliyuncs.com" />
            <div v-if="fieldError('endpoint')" class="field-error">{{ fieldError('endpoint') }}</div>
            <div v-else class="field-help">{{ t('obs.slsEndpointHelp') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldProject') }} *</label>
          <div class="field-wrap">
            <input v-model="draft.project" />
            <div v-if="fieldError('project')" class="field-error">{{ fieldError('project') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldLogstore') }} *</label>
          <div class="field-wrap">
            <input v-model="draft.logstore" />
            <div v-if="fieldError('logstore')" class="field-error">{{ fieldError('logstore') }}</div>
          </div>
        </div>
      </template>

      <!-- Object storage -->
      <template v-else>
        <div class="form-row">
          <label>{{ t('obs.fieldProvider') }}</label>
          <div class="field-wrap">
            <select v-model="draft.provider">
              <option value="s3">S3（含 MinIO / OSS / R2 兼容）</option>
              <option value="gcs">GCS</option>
              <option value="azure_blob">Azure Blob</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldBucket') }} *</label>
          <div class="field-wrap">
            <input v-model="draft.bucket" />
            <div v-if="fieldError('bucket')" class="field-error">{{ fieldError('bucket') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldPrefix') }} *</label>
          <div class="field-wrap">
            <input v-model="draft.prefix" placeholder="ai-gateway" />
            <div v-if="fieldError('prefix')" class="field-error">{{ fieldError('prefix') }}</div>
            <div v-else class="field-help">{{ t('obs.prefixHelp') }}</div>
          </div>
        </div>
        <div class="form-row">
          <label>{{ t('obs.fieldAuthMode') }}</label>
          <div class="field-wrap">
            <select v-model="draft.auth_mode">
              <option value="credential_ref">{{ t('obs.authModeCredentialRef') }}</option>
              <option value="cloud_identity">{{ t('obs.authModeCloudIdentity') }}</option>
            </select>
            <div v-if="fieldError('auth_mode')" class="field-error">{{ fieldError('auth_mode') }}</div>
          </div>
        </div>
        <template v-if="draft.provider === 's3'">
          <div class="form-row">
            <label>{{ t('obs.fieldRegion') }}</label>
            <div class="field-wrap">
              <input v-model="draft.region" placeholder="us-east-1" />
              <div class="field-help">{{ t('obs.regionHelp') }}</div>
            </div>
          </div>
          <div class="form-row">
            <label>{{ t('obs.fieldObjEndpoint') }}</label>
            <div class="field-wrap">
              <input v-model="draft.endpoint" placeholder="https://minio.example.com" />
              <div v-if="fieldError('endpoint')" class="field-error">{{ fieldError('endpoint') }}</div>
              <div v-else class="field-help">{{ t('obs.objEndpointHelp') }}</div>
            </div>
          </div>
          <div class="form-row">
            <label>{{ t('obs.fieldCompression') }}</label>
            <div class="field-wrap">
              <select v-model="draft.compression">
                <option value="gzip">gzip</option>
                <option value="none">none</option>
              </select>
            </div>
          </div>
        </template>
      </template>

      <div class="form-row">
        <label>{{ t('obs.fieldEnabled') }}</label>
        <div class="field-wrap">
          <label style="justify-self: start"><input type="checkbox" v-model="draft.enabled" /></label>
          <div class="field-help">{{ t('obs.fieldEnabledHelp') }}</div>
        </div>
      </div>

      <div v-if="previewDestination" class="dest-preview">
        {{ t('obs.destPreview') }}：<code>{{ previewDestination }}</code>
      </div>
    </div>

    <!-- 3. credential chain -->
    <div class="obs-step">
      <div class="obs-step-title">{{ t('obs.step3') }}</div>
      <p class="muted" style="font-size: 12px; margin-top: -4px">{{ t('obs.credIntro') }}</p>

      <div v-if="needsCredentialRef" class="form-row">
        <label>{{ t('obs.credRefLabel') }} *</label>
        <div class="field-wrap">
          <input v-model="draft.credential_ref" placeholder="sls-prod" />
          <div v-if="fieldError('credential_ref')" class="field-error">{{ fieldError('credential_ref') }}</div>
          <div v-else class="field-help">{{ t('obs.credRefHelp') }}</div>
        </div>
      </div>

      <div v-if="planError" class="error-box">{{ planError }}</div>

      <template v-else-if="plan">
        <div v-if="plan.note" class="field-help" style="margin-bottom: 8px">{{ plan.note }}</div>

        <template v-if="plan.vars.length">
          <div class="cred-status" :class="plan.allRequiredSet ? 'ok' : 'warn'">
            {{ plan.allRequiredSet ? t('obs.credAllSet') : t('obs.credMissing') }}
          </div>
          <table style="margin-top: 8px">
            <thead>
              <tr>
                <th>{{ t('obs.credVarName') }}</th>
                <th>{{ t('obs.credVarFor') }}</th>
                <th>{{ t('common.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in plan.vars" :key="v.name">
                <td><code>{{ v.name }}</code></td>
                <td class="muted">
                  {{ v.label }}<span v-if="!v.required"> · {{ t('obs.credOptional') }}</span>
                </td>
                <td>
                  <span class="badge" :class="v.set ? 'ok' : 'err'">
                    {{ v.set ? t('obs.credSet') : t('obs.credNotSet') }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="field-help" style="margin-top: 6px">{{ t('obs.credEnvScope') }}</div>

          <div v-if="plan.snippets" style="margin-top: 8px">
            <button style="padding: 3px 10px; font-size: 12px" @click="showSnippets = !showSnippets">
              {{ showSnippets ? '▾' : '▸' }} {{ t('obs.credSnippets') }}
            </button>
            <div v-if="showSnippets" style="margin-top: 8px">
              <div style="display: flex; gap: 6px; margin-bottom: 8px">
                <button
                  v-for="tab in ['compose', 'dockerRun', 'dotenv']"
                  :key="tab"
                  :class="{ primary: snippetTab === tab }"
                  style="padding: 3px 10px; font-size: 12px"
                  @click="snippetTab = tab"
                >
                  {{ t('obs.cred' + tab.charAt(0).toUpperCase() + tab.slice(1)) }}
                </button>
              </div>
              <pre class="snippet">{{ plan.snippets[snippetTab] }}</pre>
            </div>
          </div>
        </template>

        <div v-else class="field-help">{{ t('obs.credNoVars') }}</div>
      </template>
    </div>

    <!-- 4. privacy -->
    <div v-if="hasContentMode" class="obs-step">
      <div class="obs-step-title">{{ t('obs.step4') }}</div>
      <div class="form-row">
        <label>{{ t('obs.contentMode') }}</label>
        <div class="field-wrap">
          <select v-model="draft.content_mode">
            <option value="metadata_only">{{ t('obs.contentMetadata') }}</option>
            <option value="full">{{ t('obs.contentFull') }}</option>
          </select>
          <div class="field-help">{{ t('obs.contentHelp') }}</div>
        </div>
      </div>
      <div v-if="draft.content_mode === 'full'" class="form-row">
        <label>{{ t('obs.contentMaxBytes') }}</label>
        <div class="field-wrap">
          <input v-model="draft.content_max_bytes" type="number" min="1" :max="1048576" />
          <div v-if="fieldError('content_max_bytes')" class="field-error">
            {{ fieldError('content_max_bytes') }}
          </div>
          <div v-else class="field-help">
            {{ t('obs.contentMaxBytesHelp') }}
            <button class="link-btn" @click="useDefaultContentBytes">{{ t('obs.useDefault') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.obs-step {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 12px;
}
.obs-step:first-child {
  border-top: none;
  padding-top: 0;
  margin-top: 0;
}
.obs-step-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.target-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.target-card {
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text);
}
.target-card.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.target-name {
  font-size: 13px;
  font-weight: 600;
}
.target-desc {
  font-size: 11px;
  color: var(--muted);
  margin-top: 3px;
  line-height: 1.4;
}
.field-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.field-help {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}
.field-error {
  font-size: 11px;
  color: var(--red);
  line-height: 1.5;
}
.dest-preview {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}
.cred-status {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
}
.cred-status.ok {
  background: rgba(34, 197, 94, 0.12);
  color: var(--green);
}
.cred-status.warn {
  background: rgba(245, 158, 11, 0.12);
  color: var(--amber);
}
.snippet {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  overflow-x: auto;
  margin: 0;
  white-space: pre;
}
.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  padding: 0 0 0 4px;
}
</style>
