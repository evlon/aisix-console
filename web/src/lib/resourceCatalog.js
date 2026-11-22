// The resources.yaml surface, described the way an operator thinks about it
// rather than the order the collections happen to have in the file.
//
// WHY THIS EXISTS: the old view was a flat row of 15 buttons (one per
// collection) plus one generic hint line that only mentioned five of them. A
// user could not tell what any of them did, or whether they needed it. So the
// page now opens on a catalogue grouped by where each resource sits in a
// request's life, and every resource carries copy answering the same fixed
// questions (see ResourceFacts.vue).
//
// COPY LIVES IN i18n, NOT HERE. This module is structure only: which kinds
// exist, which group they belong to, which page owns them, what their table
// columns are, and which failure modes apply. The strings are under
// `resourceCatalog.*` in web/src/i18n/locales/resource-catalog.<locale>.js, and
// web/test/resourceCatalog.test.js asserts this file and those keys agree —
// so a kind added here without copy fails the suite instead of rendering a raw
// key to the user.

// Where the resource sits in a request's life. Order matters: it is the order
// the page renders, and it doubles as the answer to "what do I configure
// first". web/test/resourceCatalog.test.js pins the membership.
export const GROUPS = ['access', 'identity', 'govern', 'meter'];

// All 21 collections the file-mode loader knows (server/src/resources.js KINDS).
//
// `ownPage`: the console maintains this kind on a dedicated page. The catalogue
// still lists it — that is the point of the redesign, because nothing in the
// console used to say where the other six went. Its detail view links out
// instead of offering an editor, so there is exactly one place to edit it.
//
// `rawOnly`: no form exists yet; the modal opens on the raw-YAML tab. Tracked
// here so the card can say so instead of surprising the user in the modal.
export const KINDS = [
  // ── access: getting models and services in ──
  { key: 'provider_keys', group: 'access', ownPage: '/provider-keys' },
  { key: 'models', group: 'access', ownPage: '/models' },
  { key: 'mcp_servers', group: 'access' },
  { key: 'a2a_agents', group: 'access' },
  { key: 'passthrough_routes', group: 'access' },

  // ── identity: who is calling and what they may use ──
  { key: 'api_keys', group: 'identity', ownPage: '/api-keys' },
  { key: 'teams', group: 'identity' },
  { key: 'users', group: 'identity' },
  { key: 'oidc_providers', group: 'identity' },
  { key: 'claim_mappings', group: 'identity' },
  { key: 'mcp_auth_settings', group: 'identity' },
  { key: 'mcp_policies', group: 'identity', rawOnly: true },

  // ── govern: what happens to a request once it is allowed in ──
  { key: 'guardrails', group: 'govern', ownPage: '/policies' },
  { key: 'guardrail_attachments', group: 'govern' },
  { key: 'cache_policies', group: 'govern', ownPage: '/policies' },
  { key: 'rate_limit_policies', group: 'govern', ownPage: '/policies' },

  // ── meter: what it cost and where the usage goes ──
  { key: 'pricing', group: 'meter', rawOnly: true },
  { key: 'budgets', group: 'meter', rawOnly: true },
  { key: 'budget_policy', group: 'meter', rawOnly: true },
  { key: 'usage_accounting', group: 'meter', rawOnly: true },
  { key: 'observability_exporters', group: 'meter' },
];

export const KIND_KEYS = KINDS.map((k) => k.key);

export const kindOf = (key) => KINDS.find((k) => k.key === key);

// The owning page's display name comes from the app's own nav labels, because
// the page name is not the resource name: `guardrails` lives on the page called
// "策略" (Policies), not "护栏". Reusing `app.nav.*` also avoids a second copy
// of these four names that could drift from the navigation.
export const OWN_PAGE_NAV = {
  '/provider-keys': 'providerKeys',
  '/models': 'models',
  '/api-keys': 'apiKeys',
  '/policies': 'policies',
};

// Table columns per kind, only for the kinds the console actually lists. The
// own-page kinds deliberately have none: their detail view links out rather
// than duplicating a table the dedicated page already renders.
//
// The header text for each field comes from `resourceCatalog.col.<field>`;
// resourceCatalog.test.js asserts every field named here has a label in both
// locales, because the columns used to fall through to the raw field name —
// which is how a Chinese UI ended up showing "AUTH_TYPE" and "DESTINATION".
export const COLS = {
  mcp_servers: ['name', 'type', 'url', 'auth_type', 'enabled'],
  a2a_agents: ['name', 'url', 'protocol_version', 'auth_type', 'enabled'],
  passthrough_routes: ['name', 'path_prefix', 'target_url', 'enabled'],
  oidc_providers: ['name', 'issuer', 'identity_claim', 'enabled'],
  claim_mappings: ['name', 'jwt_provider', 'priority', 'enabled'],
  mcp_auth_settings: ['resource_url', 'anonymous'],
  guardrail_attachments: ['guardrail_id', 'scope_type', 'scope_id', 'priority', 'enabled'],
  observability_exporters: ['name', 'destination', 'content', 'enabled'],
  teams: ['name'],
  users: ['name'],
  pricing: ['key', 'input_per_1k', 'output_per_1k'],
  budgets: ['scope', 'scope_ref', 'period'],
  budget_policy: ['fail_mode', 'closed_grace_seconds'],
  usage_accounting: ['exclude_estimated_usage'],
  mcp_policies: ['scope', 'scope_ref', 'enabled'],
};

// Who references this kind, and by which identity: `id` means the referencing
// field holds the target's UUID, `name` means it holds its name. This is the
// single most common place to get a resource wrong, so the detail view states
// it rather than leaving it to be inferred from a 400.
export const RELATIONS = {
  provider_keys: [
    { from: 'models', field: 'provider_key_id', by: 'id' },
    { from: 'passthrough_routes', field: 'provider_key_id', by: 'id' },
  ],
  models: [
    { from: 'api_keys', field: 'allowed_model_ids', by: 'id' },
    { from: 'models', field: 'routing.targets / ensemble.panel', by: 'name' },
    { from: 'cache_policies', field: 'applies_to', by: 'name' },
  ],
  mcp_servers: [
    { from: 'api_keys', field: 'mcp_access', by: 'name' },
    { from: 'mcp_auth_settings', field: 'anonymous.servers', by: 'name' },
    { from: 'mcp_policies', field: 'allow', by: 'name' },
  ],
  a2a_agents: [{ from: 'api_keys', field: 'allowed_agents', by: 'name' }],
  passthrough_routes: [{ from: 'api_keys', field: 'allowed_routes', by: 'name' }],
  api_keys: [
    { from: 'mcp_auth_settings', field: 'anonymous.api_key_id', by: 'id' },
    { from: 'claim_mappings', field: 'resolve.api_key_id', by: 'id' },
  ],
  teams: [
    { from: 'api_keys', field: 'team_id', by: 'id' },
    { from: 'rate_limit_policies', field: 'scope_ref', by: 'id' },
    { from: 'budgets', field: 'scope_ref', by: 'id' },
    { from: 'mcp_policies', field: 'scope_ref', by: 'id' },
  ],
  users: [
    { from: 'api_keys', field: 'user_id', by: 'id' },
    { from: 'rate_limit_policies', field: 'scope_ref', by: 'id' },
    { from: 'budgets', field: 'scope_ref', by: 'id' },
  ],
  oidc_providers: [
    { from: 'api_keys', field: 'jwt_provider', by: 'name' },
    { from: 'claim_mappings', field: 'jwt_provider', by: 'name' },
  ],
  claim_mappings: [],
  // Nothing references these two; what they depend on belongs in their copy,
  // not in a reference list — a half-modelled edge here would be worse than
  // none.
  mcp_auth_settings: [],
  mcp_policies: [],
  guardrails: [
    { from: 'guardrail_attachments', field: 'guardrail_id', by: 'id' },
    { from: 'models', field: 'semantic.embedding_model_id', by: 'id' },
  ],
  guardrail_attachments: [],
  cache_policies: [],
  rate_limit_policies: [],
  pricing: [{ from: 'models', field: 'pricing_key', by: 'name' }],
  budgets: [],
  budget_policy: [],
  usage_accounting: [],
  observability_exporters: [],
};

// Failure modes that apply to this kind, in the order the copy lists them.
// Values index into `resourceCatalog.fail.<mode>` (what the mode means) and
// `resourceCatalog.kind.<key>.mis.<i>` (this kind's instance of it).
//
//   file   the whole resources.yaml is rejected: at startup the gateway does
//          not come up; on SIGHUP the previous config keeps serving.
//   row    only this row is dropped; the rest loads, state goes degraded, and
//          /status/config lists it under rejected[].
//   silent the config is valid and loads, but never matches anything.
//
// `silent` is why this exists at all: every other failure announces itself
// somewhere, and that one does not.
export const MIS_MODES = {
  provider_keys: ['file', 'row', 'silent'],
  models: ['row', 'silent', 'silent'],
  mcp_servers: ['row', 'row', 'row'],
  a2a_agents: ['row', 'row', 'silent'],
  passthrough_routes: ['row', 'row', 'silent'],
  api_keys: ['silent', 'silent', 'silent'],
  teams: ['silent', 'silent', 'row'],
  users: ['silent', 'silent', 'row'],
  oidc_providers: ['row', 'row', 'silent', 'silent'],
  claim_mappings: ['silent', 'silent', 'silent', 'silent'],
  mcp_auth_settings: ['silent', 'silent', 'row'],
  mcp_policies: ['silent', 'silent', 'silent', 'silent'],
  guardrails: ['silent', 'silent', 'silent', 'row'],
  guardrail_attachments: ['row', 'silent', 'silent', 'silent'],
  cache_policies: ['silent', 'silent', 'silent', 'silent'],
  rate_limit_policies: ['row', 'row', 'silent', 'silent', 'silent'],
  pricing: ['silent', 'silent', 'silent'],
  budgets: ['silent', 'silent', 'silent'],
  budget_policy: ['row', 'row', 'silent'],
  usage_accounting: ['row', 'silent', 'silent'],
  observability_exporters: ['row', 'silent', 'silent', 'silent'],
};

// The `applies_to` values the gateway accepts, and what any other value means.
// The gateway parses this field as a free string and treats anything it does
// not recognise — including the empty string — as `all`, so a typo silently
// widens the policy from one model to the whole environment. Kept beside the
// catalogue so the form hint and the effect self-check spell it the same way.
export const CACHE_APPLIES_TO = ['all', 'model:', 'api_key:'];
