<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import RawYamlEditor from '../components/RawYamlEditor.vue';
import ExporterForm from '../components/ExporterForm.vue';
import ExporterHealth from '../components/ExporterHealth.vue';
import GatewayFeedback from '../components/GatewayFeedback.vue';
import ResourceCard from '../components/ResourceCard.vue';
import ResourceFacts from '../components/ResourceFacts.vue';
import { useStatusStore } from '../stores/status.js';
import {
  COLS,
  GROUPS,
  KINDS as CATALOG_KINDS,
  OWN_PAGE_NAV,
} from '../lib/resourceCatalog.js';
import {
  defaultDraft as defaultExporterDraft,
  draftFromEntry as draftFromExporterEntry,
  buildEntry as buildExporterEntry,
  validateDraft as validateExporterDraft,
  destinationOf,
  contentModeOf,
} from '../lib/exporterTargets.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const { t, te } = useI18n();
const status = useStatusStore();

// The catalogue structure (groups, owning pages, columns, failure modes) lives
// in web/src/lib/resourceCatalog.js and the copy in i18n under
// `resourceCatalog.*`. This view keeps only what the editor needs on top.
const KINDS = CATALOG_KINDS.map((k) => ({
  ...k,
  label: () => t(`resourceCatalog.kind.${k.key}.label`),
}));

// Kinds with no form branch: the modal opens on the raw-YAML tab.
const RAW_YAML_ONLY = new Set(CATALOG_KINDS.filter((k) => k.rawOnly).map((k) => k.key));

// The four steps that get one model call through the gateway end to end — the
// answer to "where do I start", which a wall of buttons never gave.
const GUIDE = ['provider_keys', 'models', 'api_keys', 'observability_exporters'];

// The three ways the gateway reacts to a bad resource, worst first. The last
// one is the reason this page says anything about failure at all.
const FAIL_MODES = ['file', 'row', 'silent'];
const MODE_CLS = { file: 'err', row: 'warn', silent: 'plain' };


// Starting point for a new entry, so the raw tab is not an empty box. Only the
// fields upstream requires are pre-filled; the rest is left to the operator.
const RAW_SKELETONS = {
  teams: { name: '' },
  users: { name: '' },
  pricing: { key: '', input_per_1k: 0, output_per_1k: 0 },
  budgets: { scope: 'api_key', scope_ref: '', period: 'day' },
  budget_policy: { fail_mode: 'sticky', closed_grace_seconds: 60 },
  usage_accounting: { exclude_estimated_usage: false },
  mcp_policies: { scope: 'env', allow: ['*'], enabled: true },
};

const IDENTITY = {
  mcp_servers: 'name',
  a2a_agents: 'name',
  oidc_providers: 'name',
  observability_exporters: 'name',
  claim_mappings: 'name',
  guardrail_attachments: null, // composite: guardrail_id + scope_type + scope_id
  passthrough_routes: 'name',
  mcp_auth_settings: null, // singleton
  teams: 'name',
  users: 'name',
  pricing: 'key', // pricing is keyed by its lookup key, not a name
  budgets: null, // composite: scope + scope_ref
  budget_policy: null, // singleton
  usage_accounting: null, // singleton
  mcp_policies: null, // composite: scope + scope_ref
};

// Compute a stable URL identity for an entry, mirroring the backend
// `identityOf` exactly (composite triple for attachments, fixed for the
// singletons, scope-based for budgets / mcp_policies).
function urlIdentityOf(e) {
  const k = activeKind.value;
  if (k === 'mcp_auth_settings' || k === 'budget_policy' || k === 'usage_accounting') return k;
  if (k === 'guardrail_attachments') {
    const g = e?.guardrail_id ?? '';
    const t = e?.scope_type ?? '';
    const s = e?.scope_id ?? '-';
    return `${g}/${t}/${s}`;
  }
  if (k === 'budgets') {
    return e?.scope === 'tag'
      ? `tag:${e?.tag?.key ?? ''}=${e?.tag?.value ?? ''}`
      : `${e?.scope ?? ''}:${e?.scope_ref ?? ''}`;
  }
  if (k === 'mcp_policies') return e?.scope === 'team' ? `team:${e?.scope_ref ?? ''}` : 'env';
  const field = IDENTITY[k];
  return e?.[field] ?? e?.name ?? e?.display_name ?? '';
}

const activeKind = ref(KINDS[0].key);
const entries = ref([]);
const apiKeys = ref([]);
const apiKeyIds = ref([]); // [{ identity, id }] for name->UUID (mcp_auth_settings)
const providerKeys = ref([]); // provider_key display_name list (passthrough_routes)
const loading = ref(false);

// Name lists for cross-collection reference dropdowns (P1). Each key maps to
// the identity field of that referenced collection; `teams` is synthesized
// from api_keys[].team_id (the only file-side team source).
const LOOKUP_KINDS = {
  provider_keys: 'display_name',
  models: 'display_name',
  api_keys: 'display_name',
  guardrails: 'name',
  mcp_servers: 'name',
  oidc_providers: 'name',
  passthrough_routes: 'name',
};
const lookups = ref({}); // kind -> [identity, ...]
const teamNames = ref([]); // distinct api_keys[].team_id (guardrail_attachments scope_type: team)
const editing = ref(null); // { original, entry }
const saving = ref(false);
const lastResult = ref(null);
const tab = ref('form');
const rawText = ref('');
// Two-level view: the catalogue of every collection, then one resource's
// detail. Own-page kinds still open their detail — that is how the six
// questions stay reachable for all 21 — but their detail links out instead of
// offering an editor, so each resource still has exactly one place to edit.
const view = ref('catalog');

const kindOf = (key) => KINDS.find((k) => k.key === key);

function emptyEntry() {
  const k = activeKind.value;
  if (k === 'mcp_servers') {
    return {
      name: '', type: 'mcp', url: '', transport: 'streamable_http',
      auth_type: 'none', secret: '', client_id: '', token_url: '', scopes: [''],
      spec_text: '', api_key_header: '', timeout_ms: '', enabled: true,
      forward_client_headers: '',
    };
  }
  if (k === 'a2a_agents') {
    return {
      name: '', url: '', protocol_version: '1.0',
      auth_type: 'none', secret: '', timeout_ms: '', enabled: true,
      forward_client_headers: '',
    };
  }
  if (k === 'oidc_providers') {
    return {
      name: '', issuer: '', audiences: [''], jwks_uri: '', identity_claim: 'sub',
      required_scopes: [''], bound_claims_text: '{}', leeway_secs: 0, enabled: true,
      hmac_secret: '',
    };
  }
  if (k === 'observability_exporters') {
    return defaultExporterDraft('otlp_http');
  }
  if (k === 'guardrail_attachments') {
    return {
      guardrail_id: '', scope_type: 'model', scope_id: '', priority: 0, enabled: true,
    };
  }
  if (k === 'passthrough_routes') {
    return {
      name: '', path_prefix: '', hosts: '', target_url: '', preserve_host: false,
      auth_mode: 'gateway_key', auth_header_name: '', anonymous_key: '',
      source_cidrs: '', credential_mode: 'inject', provider_key: '',
      identity_header: '', forward_client_headers: '', timeout_ms: '', enabled: true,
    };
  }
  if (k === 'mcp_auth_settings') {
    return {
      resource_url: '', anonymous_enabled: false, anonymous_api_key: '',
      anonymous_source_cidrs: '', anonymous_servers: '', anonymous_aggregate_entry: false,
    };
  }
  if (RAW_YAML_ONLY.has(k)) {
    // The form is not used for these; the raw tab owns them. An empty object
    // keeps the modal harmless if the tabs are switched by hand.
    return { ...(RAW_SKELETONS[k] ?? {}) };
  }
  // claim_mappings
  return {
    name: '', jwt_provider: '', priority: 0,
    match: [{ claim: '', op: 'exact', values: [''] }],
    resolve_api_key: '', enabled: true,
  };
}

const form = ref(emptyEntry());

function parseJsonObj(text, label) {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

const strArr = (v) =>
  String(v || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function clean(o) {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
  }
  return o;
}

function openCreate() {
  form.value = emptyEntry();
  editing.value = { original: null };
  lastResult.value = null;
  const kind = activeKind.value;
  if (RAW_YAML_ONLY.has(kind)) {
    // No form for these: open on the raw tab with a minimal, valid skeleton so
    // the operator is not staring at an empty editor.
    tab.value = 'raw';
    rawText.value = stringifyYaml(RAW_SKELETONS[kind] ?? {}, { lineWidth: 0 });
    return;
  }
  tab.value = 'form';
  rawText.value = '';
}

function openEdit(e) {
  editing.value = { original: e };
  const f = JSON.parse(JSON.stringify(e));
  const k = activeKind.value;
  if (RAW_YAML_ONLY.has(k)) {
    form.value = f;
    lastResult.value = null;
    tab.value = 'raw';
    rawText.value = stringifyYaml(e, { lineWidth: 0 });
    return;
  }
  if (k === 'mcp_servers') {
    f.spec_text = e.spec ? JSON.stringify(e.spec, null, 2) : '';
    f.scopes = e.scopes?.length ? e.scopes : [''];
    if (!f.auth_type) f.auth_type = 'none';
    if (!f.name && e.display_name) f.name = e.display_name;
    f.forward_client_headers = (e.forward_client_headers ?? []).join(', ');
  }
  if (k === 'a2a_agents') {
    if (!f.auth_type) f.auth_type = 'none';
    if (!f.name && e.display_name) f.name = e.display_name;
    f.forward_client_headers = (e.forward_client_headers ?? []).join(', ');
  }
  if (k === 'oidc_providers') {
    f.audiences = e.audiences?.length ? e.audiences : [''];
    f.required_scopes = e.required_scopes?.length ? e.required_scopes : [''];
    f.bound_claims_text = e.bound_claims ? JSON.stringify(e.bound_claims, null, 2) : '{}';
    if (f.leeway_secs === undefined) f.leeway_secs = 0;
    f.hmac_secret = e.hmac_secret ?? '';
  }
  if (k === 'observability_exporters') {
    // The exporter draft is a different shape from the stored entry (header and
    // tag text, content-cap defaults), so build it rather than patching `f`.
    form.value = draftFromExporterEntry(e, e.kind || 'otlp_http');
    lastResult.value = null;
    tab.value = 'form';
    rawText.value = stringifyYaml(e, { lineWidth: 0 });
    return;
  }
  if (k === 'claim_mappings') {
    f.match = e.match?.length ? e.match.map((m) => ({
      claim: m.claim, op: m.op || 'exact', values: m.values?.length ? m.values : [''],
    })) : [{ claim: '', op: 'exact', values: [''] }];
    f.resolve_api_key = e.resolve?.api_key ?? e.resolve?.api_key_id ?? '';
  }
  if (k === 'guardrail_attachments') {
    f.guardrail_id = e.guardrail_id ?? '';
    f.scope_type = e.scope_type ?? 'model';
    f.scope_id = e.scope_id ?? '';
    f.priority = e.priority ?? 0;
  }
  if (k === 'passthrough_routes') {
    f.hosts = (e.hosts ?? []).join(', ');
    f.path_prefix = e.path_prefix ?? '';
    f.target_url = e.target_url ?? '';
    f.preserve_host = !!e.preserve_host;
    f.auth_mode = e.auth_mode ?? 'gateway_key';
    f.auth_header_name = e.auth_header_name ?? '';
    f.anonymous_key = e.anonymous_key ?? e.anonymous_key_id ?? '';
    f.source_cidrs = (e.source_cidrs ?? []).join(', ');
    f.credential_mode = e.credential_mode ?? 'inject';
    f.provider_key = e.provider_key ?? e.provider_key_id ?? '';
    f.identity_header = e.identity_header ?? '';
    f.forward_client_headers = (e.forward_client_headers ?? []).join(', ');
    f.timeout_ms = e.timeout_ms ?? '';
  }
  if (k === 'mcp_auth_settings') {
    f.resource_url = e.resource_url ?? '';
    f.anonymous_enabled = !!e.anonymous?.enabled;
    // The form stores the api_key NAME; map an existing api_key_id back to its
    // name so the picker shows the current value (falls back to the raw id if
    // we can't resolve it, e.g. the id names a key outside this file).
    const rawId = e.anonymous?.api_key_id ?? e.anonymous?.api_key ?? '';
    f.anonymous_api_key = apiKeyIds.value.find((r) => r.id === rawId)?.identity ?? rawId;
    f.anonymous_source_cidrs = (e.anonymous?.source_cidrs ?? []).join(', ');
    f.anonymous_servers = (e.anonymous?.servers ?? []).join(', ');
    f.anonymous_aggregate_entry = !!e.anonymous?.aggregate_entry;
  }
  form.value = f;
  lastResult.value = null;
  tab.value = 'form';
  rawText.value = stringifyYaml(e, { lineWidth: 0 });
}

function buildEntry() {
  const f = JSON.parse(JSON.stringify(form.value));
  const k = activeKind.value;

  if (RAW_YAML_ONLY.has(k)) {
    // Refuse rather than write a half-empty row built from a form that does not
    // model this resource. The raw tab is the supported path.
    throw new Error(t('resources.useRawYaml'));
  }

  if (k === 'mcp_servers') {
    const out = clean({
      name: f.name,
      type: f.type,
      url: f.url,
      transport: f.transport || 'streamable_http',
      auth_type: f.auth_type || 'none',
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
    });
    if (f.auth_type !== 'none') out.secret = f.secret;
    if (f.auth_type === 'oauth2') {
      out.client_id = f.client_id;
      out.token_url = f.token_url;
      const scopes = (f.scopes || []).map((s) => s.trim()).filter(Boolean);
      if (scopes.length) out.scopes = scopes;
    }
    if (f.type === 'openapi') {
      out.spec = parseJsonObj(f.spec_text, 'spec');
      if (f.auth_type === 'api_key') out.api_key_header = f.api_key_header;
    }
    const fch = strArr(f.forward_client_headers);
    if (fch.length) out.forward_client_headers = fch;
    return out;
  }

  if (k === 'a2a_agents') {
    const fch = strArr(f.forward_client_headers);
    return clean({
      name: f.name,
      url: f.url,
      protocol_version: f.protocol_version || '1.0',
      auth_type: f.auth_type || 'none',
      secret: f.auth_type !== 'none' ? f.secret : undefined,
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
      forward_client_headers: fch.length ? fch : undefined,
    });
  }

  if (k === 'oidc_providers') {
    const audiences = (f.audiences || []).map((a) => a.trim()).filter(Boolean);
    if (!audiences.length && !f.hmac_secret) throw new Error('audiences (or hmac_secret)');
    return clean({
      name: f.name,
      issuer: f.issuer,
      audiences,
      jwks_uri: f.jwks_uri,
      identity_claim: f.identity_claim,
      required_scopes: (f.required_scopes || []).map((s) => s.trim()).filter(Boolean),
      bound_claims: parseJsonObj(f.bound_claims_text, 'bound_claims'),
      leeway_secs: f.leeway_secs !== '' ? Number(f.leeway_secs) : undefined,
      enabled: !!f.enabled,
      hmac_secret: f.hmac_secret || undefined,
    });
  }

  if (k === 'observability_exporters') {
    // Delegated to the shared mapper so the form, the tests, and the list's
    // "destination" column all agree on what gets written. It emits only the
    // fields of the selected kind, because each inner config is
    // `deny_unknown_fields` on the gateway side.
    return buildExporterEntry(f);
  }

  if (k === 'guardrail_attachments') {
    if (!f.guardrail_id) throw new Error('guardrail_id');
    return clean({
      guardrail_id: f.guardrail_id,
      scope_type: f.scope_type,
      scope_id: f.scope_type === 'env' ? undefined : f.scope_id,
      priority: f.priority !== '' ? Number(f.priority) : 0,
      enabled: !!f.enabled,
    });
  }

  if (k === 'passthrough_routes') {
    const hosts = strArr(f.hosts);
    if (!f.path_prefix && !hosts.length) throw new Error('path_prefix (or hosts)');
    // Exactly one of target_url / preserve_host.
    if (!f.target_url && !f.preserve_host) throw new Error('target_url (or preserve_host)');
    if (f.preserve_host && !hosts.length) throw new Error('hosts (required with preserve_host)');

    const authMode = f.auth_mode || 'gateway_key';
    const credentialMode = f.credential_mode || 'inject';
    if (authMode === 'header_key' && !f.auth_header_name) throw new Error('auth_header_name');
    if (authMode === 'anonymous') {
      if (!f.anonymous_key) throw new Error('anonymous_key');
      const cidrs = strArr(f.source_cidrs);
      if (!cidrs.length) throw new Error('source_cidrs');
    }
    if (credentialMode === 'inject' && !f.provider_key) throw new Error('provider_key');

    const out = clean({
      name: f.name,
      path_prefix: f.path_prefix || undefined,
      hosts: hosts.length ? hosts : undefined,
      target_url: f.target_url || undefined,
      preserve_host: f.preserve_host ? true : undefined,
      auth_mode: authMode === 'gateway_key' ? undefined : authMode,
      auth_header_name: f.auth_header_name || undefined,
      anonymous_key: authMode === 'anonymous' ? f.anonymous_key : undefined,
      source_cidrs: strArr(f.source_cidrs).length ? strArr(f.source_cidrs) : undefined,
      credential_mode: credentialMode === 'inject' ? undefined : credentialMode,
      provider_key: credentialMode === 'inject' ? f.provider_key : undefined,
      identity_header: f.identity_header || undefined,
      forward_client_headers: strArr(f.forward_client_headers).length ? strArr(f.forward_client_headers) : undefined,
      timeout_ms: f.timeout_ms !== '' ? Number(f.timeout_ms) : undefined,
      enabled: !!f.enabled,
    });
    return out;
  }

  if (k === 'mcp_auth_settings') {
    const out = clean({ resource_url: f.resource_url || undefined });
    if (f.anonymous_enabled) {
      const cidrs = strArr(f.anonymous_source_cidrs);
      const servers = strArr(f.anonymous_servers);
      if (!f.anonymous_api_key) throw new Error('anonymous.api_key_id');
      if (!cidrs.length) throw new Error('anonymous.source_cidrs');
      if (!servers.length) throw new Error('anonymous.servers');
      // The form holds the api_key NAME; resolve to the canonical UUID the
      // gateway expects (upstream has no name sugar for this field). If the
      // value is already a UUID (e.g. pasted), pass it through unchanged.
      const idRow = apiKeyIds.value.find((r) => r.identity === f.anonymous_api_key);
      const apiKeyId = idRow ? idRow.id : f.anonymous_api_key;
      out.anonymous = {
        enabled: true,
        api_key_id: apiKeyId,
        source_cidrs: cidrs,
        servers,
      };
      if (f.anonymous_aggregate_entry) out.anonymous.aggregate_entry = true;
    }
    return out;
  }

  // claim_mappings
  if (!f.name || !f.jwt_provider) throw new Error(t('common.required'));
  if (!f.resolve_api_key) throw new Error('resolve.api_key');
  const matches = (f.match || [])
    .filter((m) => m.claim && m.claim.trim())
    .map((m) => ({
      claim: m.claim.trim(),
      op: m.op || 'exact',
      values: (m.values || []).map((v) => v.trim()).filter(Boolean),
    }))
    .filter((m) => m.values.length);
  if (!matches.length) throw new Error('match');
  return clean({
    name: f.name,
    jwt_provider: f.jwt_provider,
    priority: f.priority !== '' ? Number(f.priority) : 0,
    match: matches,
    resolve: { api_key: f.resolve_api_key },
    enabled: !!f.enabled,
  });
}

async function load() {
  loading.value = true;
  try {
    const [r, k, ids, ...lookupResults] = await Promise.all([
      api.list(activeKind.value),
      api.list('api_keys'),
      api.derivedIds('api_keys'),
      ...Object.keys(LOOKUP_KINDS).map((lk) => api.list(lk)),
    ]);
    entries.value = r.entries ?? [];
    apiKeys.value = (k.entries ?? []).map((e) => e.display_name || e.key_hash?.slice(0, 8)).filter(Boolean);
    apiKeyIds.value = ids.rows ?? [];
    teamNames.value = [...new Set((k.entries ?? []).map((e) => e.team_id).filter(Boolean))];
    providerKeys.value = (lookupResults[0].entries ?? []).map((e) => e.display_name || e.name).filter(Boolean);
    const lk = {};
    Object.keys(LOOKUP_KINDS).forEach((kind, i) => {
      const field = LOOKUP_KINDS[kind];
      lk[kind] = (lookupResults[i].entries ?? [])
        .map((e) => e[field] ?? e.name ?? e.display_name)
        .filter(Boolean);
    });
    lookups.value = lk;
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function backToCatalog() {
  view.value = 'catalog';
  editing.value = null;
  lastResult.value = null;
}

function openDetail(key) {
  const rec = kindOf(key);
  activeKind.value = key;
  view.value = 'detail';
  lastResult.value = null;
  editing.value = null;
  // Own-page kinds have no table on this page, so there is nothing to fetch.
  if (!rec?.ownPage) load();
}

// Per-collection row counts come from /api/status, which already returns them
// (server/src/routes/status.js), so the catalogue costs no extra request.
const counts = computed(() => status.counts ?? {});
const config = computed(() => status.config);
const rowCount = computed(() => Object.values(counts.value).reduce((a, n) => a + (n || 0), 0));
const configuredKinds = computed(() => KINDS.filter((k) => (counts.value[k.key] || 0) > 0).length);
const groupsView = computed(() =>
  GROUPS.map((id) => {
    const kinds = KINDS.filter((k) => k.group === id);
    return { id, kinds, configured: kinds.filter((k) => (counts.value[k.key] || 0) > 0).length };
  })
);
const guideKinds = computed(() => GUIDE.map((key) => kindOf(key)).filter(Boolean));
const activeRec = computed(() => kindOf(activeKind.value) ?? KINDS[0]);
const ownPageName = (rec) => (rec?.ownPage ? t(`app.nav.${OWN_PAGE_NAV[rec.ownPage]}`) : '');

async function save() {
  const k = activeKind.value;
  if (k !== 'mcp_auth_settings' && k !== 'guardrail_attachments' && !form.value.name && !form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: t('common.required') }] };
    return;
  }
  // Block the save with the same rules the gateway's schema enforces, so the
  // user sees "endpoint 必须是 https" here instead of a JSON-pointer error
  // coming back from `aisix validate`.
  if (k === 'observability_exporters') {
    const errs = validateExporterDraft(form.value);
    const fields = Object.keys(errs);
    if (fields.length) {
      lastResult.value = {
        ok: false,
        errors: fields.map((field) => ({ message: `${field}: ${t('obs.err.' + errs[field])}` })),
      };
      return;
    }
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
    const original = editing.value?.original;
    const identity = original ? urlIdentityOf(original) : '';
    // The form path merges (the server default): the form models only part of the
    // entry, and a replace here would delete everything it does not show — which
    // is how renaming an API key used to drop its tpm/tpd token caps.
    const result = identity
      ? await api.update(activeKind.value, identity, entry)
      : await api.create(activeKind.value, entry);
    lastResult.value = result;
    if (result.ok) {
      editing.value = null;
      await load();
      await loadChecks();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function saveRaw() {
  let entry;
  try {
    entry = parseYaml(rawText.value || '', { uniqueKeys: true });
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: `YAML: ${e.message}` }] };
    return;
  }
  saving.value = true;
  try {
    const original = editing.value?.original;
    const identity = original ? urlIdentityOf(original) : '';
    // The raw tab shows the whole entry, so it means replace — editing raw YAML
    // is how a field gets removed by hand.
    const result = identity
      ? await api.update(activeKind.value, identity, entry, { mode: 'replace' })
      : await api.create(activeKind.value, entry);
    lastResult.value = result;
    if (result.ok) {
      editing.value = null;
      await load();
      await loadChecks();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function remove(e) {
  const identity = urlIdentityOf(e);
  if (!confirm(`${kindOf(activeKind.value).label()} "${identity}"?`)) return;
  try {
    const r = await api.remove(activeKind.value, identity);
    lastResult.value = r;
    if (r.ok) {
      await load();
      await loadChecks();
    }
  } catch (err) {
    lastResult.value = { ok: false, errors: [{ message: err.message }] };
  }
}

function tableCols() {
  return COLS[activeKind.value] ?? [];
}

// Column headers come from `resourceCatalog.col.<field>`. The old code fell
// back to the raw field name, which is how a Chinese UI ended up showing
// "AUTH_TYPE" and "DESTINATION". web/test/resourceCatalog.test.js asserts every
// field named in COLS has a label in both locales, so that fallback cannot come
// back silently — and if one ever slips through, a field name beats a blank.
function colLabel(field) {
  const key = `resourceCatalog.col.${field}`;
  return te(key) ? t(key) : field;
}

function cell(e, col) {
  if (col === 'enabled') return e.enabled ? t('common.enabled') : t('common.disabled');
  if (col === 'anonymous') return e.anonymous ? t('common.enabled') : t('common.disabled');
  if (col === 'display_name' || col === 'name' || col === 'key') return e[col] ?? '—';
  // "Where does it send", which the old name/kind/enabled row could not answer.
  if (col === 'destination') return destinationOf(e) || '—';
  if (col === 'content') {
    return contentModeOf(e) === 'full' ? t('obs.contentFull') : t('obs.contentMetadata');
  }
  const v = e[col];
  // The newer collections carry booleans and arrays; without this a `false`
  // renders as the string "false" and an empty list as a blank cell.
  if (typeof v === 'boolean') return v ? t('common.enabled') : t('common.disabled');
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (v && typeof v === 'object') return JSON.stringify(v);
  return v ?? '—';
}

// Findings from the server's silent-failure check, refreshed after every save.
// Hints only: a failure here must not disturb the page, so it degrades to none.
const checks = ref([]);

async function loadChecks() {
  try {
    const r = await api.effectChecks();
    checks.value = r?.checks ?? [];
  } catch {
    checks.value = [];
  }
}

onMounted(() => {
  load();
  loadChecks();
});
</script>

<template>
  <div>
    <!-- ── the catalogue: everything the gateway can be told to do ── -->
    <template v-if="view === 'catalog'">
      <!-- The page title comes from the shell (App.vue renders the route's
           titleKey), so this view does not repeat it. -->
      <div style="display: flex; justify-content: flex-end; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px">
        <span class="muted">
          {{ t('resourceCatalog.summaryKinds', { total: KINDS.length, configured: configuredKinds, entries: rowCount }) }}
          &nbsp; <router-link to="/raw">{{ t('resourceCatalog.viewRaw') }}</router-link>
        </span>
      </div>
      <p class="muted" style="margin: 6px 0 18px">{{ t('resourceCatalog.intro') }}</p>

      <GatewayFeedback :config="config" :row-count="rowCount" :checks="checks" />

      <div class="guide">
        <span>
          <strong>{{ t('resourceCatalog.guideTitle') }}</strong>
          <span class="muted">{{ t('resourceCatalog.guideHint') }}</span>
        </span>
        <template v-for="(k, i) in guideKinds" :key="k.key">
          <span v-if="i" class="muted">→</span>
          <a href="#" @click.prevent="openDetail(k.key)">{{ k.label() }}</a>
        </template>
        <span class="muted">{{ t('resourceCatalog.guideTail') }}</span>
      </div>

      <details class="legend">
        <summary>{{ t('resourceCatalog.legendTitle') }}</summary>
        <div v-for="m in FAIL_MODES" :key="m" class="item">
          <span><span class="badge" :class="MODE_CLS[m]">{{ t(`resourceCatalog.fail.${m}.label`) }}</span></span>
          <span class="muted">{{ t(`resourceCatalog.fail.${m}.text`) }}</span>
        </div>
      </details>

      <section v-for="g in groupsView" :key="g.id" class="group">
        <div class="ghead">
          <h2>{{ t(`resourceCatalog.group.${g.id}.name`) }}</h2>
          <span class="muted">
            {{ t('resourceCatalog.groupCount', { kinds: g.kinds.length, configured: g.configured }) }}
          </span>
        </div>
        <p class="muted gdesc">{{ t(`resourceCatalog.group.${g.id}.desc`) }}</p>
        <div class="grid">
          <ResourceCard
            v-for="k in g.kinds"
            :key="k.key"
            :kind="k.key"
            :count="counts[k.key] || 0"
            :own-page="k.ownPage"
            :own-page-name="ownPageName(k)"
            :raw-only="!!k.rawOnly"
            @open="openDetail(k.key)"
          />
        </div>
      </section>
    </template>

    <!-- ── one resource: the six questions, then its entries ── -->
    <template v-else>
      <div class="muted" style="margin-bottom: 10px">
        <a href="#" @click.prevent="backToCatalog">{{ t('resourceCatalog.back') }}</a>
        / {{ t(`resourceCatalog.group.${activeRec.group}.name`) }}
        / {{ activeRec.label() }}
      </div>

      <div class="dhead">
        <h2 style="margin: 0; font-size: 17px">
          {{ activeRec.label() }}
          <span v-if="(counts[activeKind] || 0) > 0" class="badge ok">
            {{ t('resourceCatalog.statusCount', { n: counts[activeKind] }) }}
          </span>
          <span v-else class="badge plain">{{ t('resourceCatalog.statusUnset') }}</span>
          <span v-if="activeRec.rawOnly" class="badge plain">{{ t('resourceCatalog.rawOnlyBadge') }}</span>
        </h2>
        <button v-if="!activeRec.ownPage" class="primary" @click="openCreate">+ {{ t('common.add') }}</button>
      </div>

      <div v-if="lastResult && !lastResult.ok" class="error-box">
        <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
      </div>

      <GatewayFeedback :config="config" :row-count="rowCount" :checks="checks" />

      <ResourceFacts :kind="activeKind" :raw-only="!!activeRec.rawOnly" />

      <ExporterHealth v-if="activeKind === 'observability_exporters'" />

      <div v-if="activeRec.ownPage" class="card muted">
        {{ t('resourceCatalog.ownedElsewhere', { page: ownPageName(activeRec) }) }}
        <router-link :to="activeRec.ownPage" style="margin-left: 8px">
          {{ t('resourceCatalog.goTo') }} →
        </router-link>
      </div>

      <div v-else class="card">
        <table>
          <thead>
            <tr>
              <th v-for="c in tableCols()" :key="c">{{ colLabel(c) }}</th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!loading && !entries.length">
              <td :colspan="tableCols().length + 1" class="muted">{{ t('resources.empty') }}</td>
            </tr>
            <tr v-for="(e, i) in entries" :key="i">
              <td v-for="c in tableCols()" :key="c">{{ cell(e, c) }}</td>
              <td>
                <button style="margin-right: 6px" @click="openEdit(e)">{{ t('common.edit') }}</button>
                <button class="danger" @click="remove(e)">{{ t('common.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <Modal v-if="editing !== null" :title="(editing.original ? t('resources.edit') : t('resources.add')) + ' — ' + kindOf(activeKind).label()" @close="editing = null">
      <div style="margin-bottom: 12px">
        <button :class="{ primary: tab === 'form' }" style="margin-right: 6px" @click="tab = 'form'">{{ t('resources.tabForm') }}</button>
        <button :class="{ primary: tab === 'raw' }" @click="tab = 'raw'">{{ t('resources.tabRaw') }}</button>
      </div>

      <template v-if="tab === 'form'">
        <!-- mcp servers -->
        <template v-if="activeKind === 'mcp_servers'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>type</label>
            <select v-model="form.type">
              <option value="mcp">mcp</option>
              <option value="openapi">openapi</option>
            </select>
          </div>
          <div class="form-row">
            <label>url *</label>
            <input v-model="form.url" placeholder="https://…/mcp" />
          </div>
          <div class="form-row">
            <label>transport</label>
            <select v-model="form.transport">
              <option value="streamable_http">streamable_http</option>
            </select>
          </div>
          <div class="form-row">
            <label>auth_type</label>
            <select v-model="form.auth_type">
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="api_key">api_key</option>
              <option value="oauth2">oauth2</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_type !== 'none'">
            <label>secret</label>
            <input v-model="form.secret" />
          </div>
          <div class="form-row" v-if="form.auth_type === 'oauth2'">
            <label>client_id</label>
            <input v-model="form.client_id" />
          </div>
          <div class="form-row" v-if="form.auth_type === 'oauth2'">
            <label>token_url</label>
            <input v-model="form.token_url" />
          </div>
          <div class="form-row" v-if="form.auth_type === 'oauth2'">
            <label>scopes</label>
            <div style="flex: 1">
              <div v-for="(s, i) in form.scopes" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.scopes[i]" style="flex: 1" />
                <button @click="form.scopes.splice(i, 1)">✕</button>
              </div>
              <button @click="form.scopes.push('')">+</button>
            </div>
          </div>
          <div class="form-row" v-if="form.type === 'openapi'">
            <label>spec (JSON) *</label>
            <textarea v-model="form.spec_text" rows="5" style="flex: 1" placeholder='{"openapi":"3.0.0",…}' />
          </div>
          <div class="form-row" v-if="form.type === 'openapi' && form.auth_type === 'api_key'">
            <label>api_key_header</label>
            <input v-model="form.api_key_header" placeholder="X-API-Key" />
          </div>
          <div class="form-row">
            <label>timeout_ms</label>
            <input v-model="form.timeout_ms" type="number" />
          </div>
          <div class="form-row">
            <label>forward_client_headers</label>
            <input v-model="form.forward_client_headers" placeholder="x-user-id, x-tenant (逗号分隔)" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- a2a agents -->
        <template v-else-if="activeKind === 'a2a_agents'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>url *</label>
            <input v-model="form.url" placeholder="https://…/a2a" />
          </div>
          <div class="form-row">
            <label>protocol_version</label>
            <select v-model="form.protocol_version">
              <option value="1.0">1.0</option>
              <option value="0.3">0.3</option>
            </select>
          </div>
          <div class="form-row">
            <label>auth_type</label>
            <select v-model="form.auth_type">
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="api_key">api_key</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_type !== 'none'">
            <label>secret</label>
            <input v-model="form.secret" />
          </div>
          <div class="form-row">
            <label>timeout_ms</label>
            <input v-model="form.timeout_ms" type="number" />
          </div>
          <div class="form-row">
            <label>forward_client_headers</label>
            <input v-model="form.forward_client_headers" placeholder="x-user-id, x-tenant (逗号分隔)" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- oidc providers -->
        <template v-else-if="activeKind === 'oidc_providers'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>issuer *</label>
            <input v-model="form.issuer" placeholder="https://…" />
          </div>
          <div class="form-row">
            <label>audiences *</label>
            <div style="flex: 1">
              <div v-for="(a, i) in form.audiences" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.audiences[i]" style="flex: 1" />
                <button @click="form.audiences.splice(i, 1)">✕</button>
              </div>
              <button @click="form.audiences.push('')">+</button>
            </div>
          </div>
          <div class="form-row">
            <label>jwks_uri</label>
            <input v-model="form.jwks_uri" />
          </div>
          <div class="form-row">
            <label>hmac_secret</label>
            <input v-model="form.hmac_secret" type="password" placeholder="共享密钥（HS256/384/512，≥32 字节）；设置后 issuer/audiences 可留空" />
          </div>
          <div class="form-row">
            <label>identity_claim</label>
            <input v-model="form.identity_claim" placeholder="sub" />
          </div>
          <div class="form-row">
            <label>required_scopes</label>
            <div style="flex: 1">
              <div v-for="(s, i) in form.required_scopes" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="form.required_scopes[i]" style="flex: 1" />
                <button @click="form.required_scopes.splice(i, 1)">✕</button>
              </div>
              <button @click="form.required_scopes.push('')">+</button>
            </div>
          </div>
          <div class="form-row">
            <label>bound_claims (JSON)</label>
            <textarea v-model="form.bound_claims_text" rows="4" style="flex: 1" placeholder='{"claim":"value"}' />
          </div>
          <div class="form-row">
            <label>leeway_secs</label>
            <input v-model="form.leeway_secs" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- observability exporters: target-oriented form, in its own component -->
        <ExporterForm
          v-else-if="activeKind === 'observability_exporters'"
          :draft="form"
          :original="editing?.original"
        />

        <!-- collections the form does not model -->
        <template v-else-if="RAW_YAML_ONLY.has(activeKind)">
          <p class="muted">{{ t('resources.useRawYaml') }}</p>
        </template>

        <!-- guardrail attachments -->
        <template v-else-if="activeKind === 'guardrail_attachments'">
          <div class="form-row">
            <label>guardrail_id *</label>
            <select v-model="form.guardrail_id">
              <option value="">选择护栏…</option>
              <option v-for="g in lookups.guardrails" :key="g" :value="g">{{ g }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>scope_type *</label>
            <select v-model="form.scope_type">
              <option value="env">env</option>
              <option value="model">model</option>
              <option value="mcp_server">mcp_server</option>
              <option value="api_key">api_key</option>
              <option value="team">team</option>
              <option value="passthrough_route">passthrough_route</option>
            </select>
          </div>
          <div class="form-row" v-if="form.scope_type === 'model'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择模型…</option>
              <option v-for="m in lookups.models" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'mcp_server'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择 MCP 服务器…</option>
              <option v-for="m in lookups.mcp_servers" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'api_key'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择调用方密钥…</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'team'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择团队…</option>
              <option v-for="t in teamNames" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="form-row" v-else-if="form.scope_type === 'passthrough_route'">
            <label>scope_id</label>
            <select v-model="form.scope_id">
              <option value="">选择透传路由…</option>
              <option v-for="p in lookups.passthrough_routes" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>priority</label>
            <input v-model="form.priority" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- passthrough routes -->
        <template v-else-if="activeKind === 'passthrough_routes'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>path_prefix</label>
            <input v-model="form.path_prefix" placeholder="/passthrough/openai（以 / 开头）" />
          </div>
          <div class="form-row">
            <label>hosts</label>
            <input v-model="form.hosts" placeholder="api.example.com, *.corp.com（逗号分隔）" />
          </div>
          <div class="form-row">
            <label>target_url</label>
            <input v-model="form.target_url" placeholder="https://upstream.example.com（与 preserve_host 二选一）" />
          </div>
          <div class="form-row">
            <label>preserve_host</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.preserve_host" /></label>
          </div>
          <div class="form-row">
            <label>auth_mode</label>
            <select v-model="form.auth_mode">
              <option value="gateway_key">gateway_key（标准网关凭证）</option>
              <option value="header_key">header_key（专用头）</option>
              <option value="anonymous">anonymous（匿名主体）</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_mode === 'header_key'">
            <label>auth_header_name *</label>
            <input v-model="form.auth_header_name" placeholder="x-aisix-api-key" />
          </div>
          <div class="form-row" v-if="form.auth_mode === 'anonymous'">
            <label>anonymous_key *</label>
            <select v-model="form.anonymous_key">
              <option value="">{{ t('resources.chooseKey') }}</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="form-row" v-if="form.auth_mode === 'anonymous'">
            <label>source_cidrs *</label>
            <input v-model="form.source_cidrs" placeholder="10.0.0.0/8, 127.0.0.1/32（逗号分隔）" />
          </div>
          <div class="form-row">
            <label>credential_mode</label>
            <select v-model="form.credential_mode">
              <option value="inject">inject（注入 ProviderKey 密钥）</option>
              <option value="forward_client">forward_client（转发调用方凭证）</option>
            </select>
          </div>
          <div class="form-row" v-if="form.credential_mode === 'inject'">
            <label>provider_key *</label>
            <select v-model="form.provider_key">
              <option value="">选择 ProviderKey…</option>
              <option v-for="p in providerKeys" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>identity_header</label>
            <input v-model="form.identity_header" placeholder="x-aisix-user（可选）" />
          </div>
          <div class="form-row">
            <label>forward_client_headers</label>
            <input v-model="form.forward_client_headers" placeholder="x-trace-*（逗号分隔 glob，可选）" />
          </div>
          <div class="form-row">
            <label>timeout_ms</label>
            <input v-model="form.timeout_ms" type="number" />
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>

        <!-- mcp auth settings (singleton) -->
        <template v-else-if="activeKind === 'mcp_auth_settings'">
          <div class="form-row">
            <label>resource_url</label>
            <input v-model="form.resource_url" placeholder="https://gw.example.com/mcp" />
          </div>
          <div class="form-row">
            <label>anonymous.enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.anonymous_enabled" /></label>
          </div>
          <template v-if="form.anonymous_enabled">
            <div class="form-row">
              <label>anonymous.api_key_id *</label>
              <select v-model="form.anonymous_api_key">
                <option value="">{{ t('resources.chooseKey') }}</option>
                <option v-for="r in apiKeyIds" :key="r.id" :value="r.identity">{{ r.identity }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>anonymous.source_cidrs *</label>
              <input v-model="form.anonymous_source_cidrs" placeholder="0.0.0.0/0, ::/0（逗号分隔）" />
            </div>
            <div class="form-row">
              <label>anonymous.servers *</label>
              <input v-model="form.anonymous_servers" placeholder="demo-mcp, another-mcp（逗号分隔）" />
            </div>
            <div class="form-row">
              <label>anonymous.aggregate_entry</label>
              <label style="justify-self: start"><input type="checkbox" v-model="form.anonymous_aggregate_entry" /></label>
            </div>
          </template>
        </template>

        <!-- claim mappings -->
        <template v-else-if="activeKind === 'claim_mappings'">
          <div class="form-row">
            <label>name *</label>
            <input v-model="form.name" />
          </div>
          <div class="form-row">
            <label>jwt_provider *</label>
            <select v-model="form.jwt_provider">
              <option value="">选择 OIDC 提供方…</option>
              <option v-for="o in lookups.oidc_providers" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>priority</label>
            <input v-model="form.priority" type="number" />
          </div>
          <div class="form-row">
            <label>match *</label>
            <div style="flex: 1">
              <div v-for="(m, i) in form.match" :key="i" style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 8px">
                <div style="display: flex; gap: 6px; margin-bottom: 6px">
                  <input v-model="m.claim" placeholder="claim path (e.g. department)" style="flex: 1" />
                  <select v-model="m.op" style="width: 110px">
                    <option value="exact">exact</option>
                    <option value="contains">contains</option>
                  </select>
                  <button @click="form.match.splice(i, 1)">✕</button>
                </div>
                <div v-for="(v, j) in m.values" :key="j" style="display: flex; gap: 6px; margin-bottom: 6px">
                  <input v-model="m.values[j]" placeholder="value" style="flex: 1" />
                  <button @click="m.values.splice(j, 1)">✕</button>
                </div>
                <button @click="m.values.push('')">+ value</button>
              </div>
              <button @click="form.match.push({ claim: '', op: 'exact', values: [''] })">+ match</button>
            </div>
          </div>
          <div class="form-row">
            <label>resolve.api_key *</label>
            <select v-model="form.resolve_api_key">
              <option value="">{{ t('resources.chooseKey') }}</option>
              <option v-for="k in apiKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>enabled</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.enabled" /></label>
          </div>
        </template>
      </template>

      <template v-else>
        <RawYamlEditor v-model="rawText" />
      </template>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
        <button @click="editing = null">{{ t('common.cancel') }}</button>
        <button class="primary" :disabled="saving" @click="tab === 'form' ? save() : saveRaw()">
          {{ saving ? t('common.saving') : t('common.saveAndReload') }}
        </button>
      </div>
      <div v-if="lastResult && lastResult.ok" class="badge ok" style="margin-top: 10px">
        {{ t('common.saved') }}{{ lastResult.reload?.warning ? t('common.sep') + lastResult.reload.warning : '' }}{{ lastResult.notice ? t('common.sep') + lastResult.notice : '' }}
      </div>
    </Modal>
  </div>
</template>

<style scoped>
/* Catalogue layout. Kept local to the view: nothing else renders cards. */
.dhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

/* First-run path: a wall of 21 capabilities still needs an entry point. */
.guide {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.legend {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 14px;
  margin-bottom: 20px;
  background: var(--panel);
}
.legend summary {
  cursor: pointer;
  padding: 8px 0;
  font-size: 13px;
  color: var(--muted);
}
.legend .item {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.legend .badge {
  white-space: nowrap;
}

.group {
  margin-bottom: 24px;
}
.ghead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 4px;
}
.ghead h2 {
  font-size: 15px;
  margin: 0;
}
.gdesc {
  font-size: 13px;
  margin: 0 0 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  align-items: start;
}
</style>
