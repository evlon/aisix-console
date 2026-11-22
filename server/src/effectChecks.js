// Effect self-check: the silent failures, detected locally.
//
// WHY THIS EXISTS: the gateway reacts to a bad resource in three ways, and only
// two of them announce themselves — the whole file can be rejected, a single
// row can be dropped (both visible in GET /status/config), or the config can be
// valid, load cleanly, and never match anything. The third has no symptom at
// all: the console says "saved", the gateway state says "synced", and the
// resource does nothing.
//
// Every check below is decidable from the file alone, so no gateway
// cooperation and no new endpoint on the gateway side are needed. They are
// HINTS, not validation: none of them blocks a save, and a hit does not
// necessarily mean the operator made a mistake (an unreferenced team can be
// deliberate). The UI presents them as such.
//
// Messages are NOT returned as prose — each finding carries a `code` and its
// `params`, and the UI translates it. Two reasons: the console is bilingual, and
// tests should assert behaviour rather than wording.
//
// Upstream basis for each rule is cited inline; see
// docs/ui/resources-redesign.zh-CN.md section 7.1.

/** Every code this module can emit. web/test/resourceCatalog.test.js asserts
 * each one has copy in both locales, so a new check cannot ship unexplained. */
export const CHECK_CODES = [
  'guardrailNoAttachment',
  'attachmentDanglingGuardrail',
  'attachmentNoPriority',
  'providerKeyNoApiBase',
  'budgetInFileMode',
  'mcpDefaultDeny',
  'mcpPolicyEmptyAllow',
  'cacheAppliesToUnknown',
  'rateLimitMixedForms',
  'rateLimitUnknownField',
  'teamNoKey',
  'memberNoKey',
  'claimMappingProviderMissing',
  'pricingUnused',
  'apiKeyAllowedModelUnknown',
];

const rows = (doc, kind) => (Array.isArray(doc?.[kind]) ? doc[kind].filter((r) => r && typeof r === 'object') : []);

/**
 * The parameters each code carries, as an explicit contract.
 *
 * The copy is interpolated on the client, so a code emitting `{n}` while its
 * translation uses `{count}` renders a literal "{count}" to the user. Both
 * suites assert against this table instead: the server test checks the params
 * it actually emits, the web test checks the placeholders its translations use.
 */
export const CHECK_PARAMS = {
  guardrailNoAttachment: ['name'],
  attachmentDanglingGuardrail: ['name'],
  attachmentNoPriority: ['name'],
  providerKeyNoApiBase: ['name'],
  budgetInFileMode: ['n'],
  mcpDefaultDeny: ['n'],
  mcpPolicyEmptyAllow: ['scope'],
  cacheAppliesToUnknown: ['policy', 'value'],
  rateLimitMixedForms: ['name'],
  rateLimitUnknownField: ['name', 'fields'],
  teamNoKey: ['name'],
  memberNoKey: ['name'],
  claimMappingProviderMissing: ['name'],
  pricingUnused: ['key'],
  apiKeyAllowedModelUnknown: ['name', 'model'],
};

// A name a human recognises. Falls back to the id so a message is never bare.
const label = (row) => row?.name || row?.display_name || row?.key || row?.id || '—';

// The two forms a rate-limit policy can take. Upstream rejects a row that mixes
// them, so this is a hint that the row will not load at all.
const CLASSIC_FIELDS = ['scope', 'scope_ref', 'window', 'max_requests', 'max_tokens'];
const CONDITION_FIELDS = ['limits', 'conditions', 'group_by', 'action'];

// Fields a rate limit does not have: there is no per-hour or per-second TOKEN
// limit, so `tph`/`tps` are silently ignored (lenient read path) and the policy
// ends up applying whatever was left.
const ABSENT_RATE_FIELDS = ['tph', 'tps', 'tps_tokens', 'tph_tokens'];

export function runEffectChecks(doc) {
  const out = [];
  const push = (kind, code, params = {}) => out.push({ kind, code, params });

  const attachments = rows(doc, 'guardrail_attachments');

  // ── guardrails ───────────────────────────────────────────────────────────
  // A guardrail carries no scope of its own: what it watches comes entirely
  // from its attachments. So "enabled but unattached" is a rule that inspects
  // nothing, which is the single most common "I configured it and nothing
  // happened" (crates/aisix-guardrails/src/build.rs:1619).
  const attachedIds = new Set(attachments.map((a) => a.guardrail_id).filter(Boolean));
  for (const g of rows(doc, 'guardrails')) {
    if (g.enabled === false) continue;
    if (g.id && !attachedIds.has(g.id)) push('guardrails', 'guardrailNoAttachment', { name: label(g) });
  }

  // An attachment pointing at a guardrail that does not exist is skipped with a
  // warning and nothing else (build.rs:1379-1389).
  const guardrailIds = new Set(rows(doc, 'guardrails').map((g) => g.id).filter(Boolean));
  for (const a of attachments) {
    if (a.guardrail_id && !guardrailIds.has(a.guardrail_id)) {
      push('guardrail_attachments', 'attachmentDanglingGuardrail', { name: a.guardrail_id });
    }
    // `priority` is required and has no default: omitting it fails the load.
    if (a.priority === undefined || a.priority === null) {
      push('guardrail_attachments', 'attachmentNoPriority', { name: label(a) });
    }
  }

  // ── provider keys ────────────────────────────────────────────────────────
  // Only `provider: openai` (or no provider with `adapter: openai`) gets a
  // built-in base URL. Anything else without api_base answers every request
  // with 400 "has no api_base configured" — a 400, not a 502, so the instinct
  // to go and check the upstream is the wrong direction
  // (crates/aisix-proxy/src/dispatch.rs:463-489).
  for (const p of rows(doc, 'provider_keys')) {
    if (p.api_base) continue;
    const hasDefault = p.provider === 'openai' || (!p.provider && p.adapter === 'openai');
    if (!hasDefault) push('provider_keys', 'providerKeyNoApiBase', { name: label(p) });
  }

  // ── budgets ──────────────────────────────────────────────────────────────
  // `exhausted` is written by the managed control plane at runtime; a gateway
  // loading this file has nothing to write or clear it, so a budget here is
  // never enforced. Upstream's exporter says as much in a warning
  // (crates/aisix-server/src/export/document.rs:392-398).
  const budgets = rows(doc, 'budgets');
  if (budgets.length) push('budgets', 'budgetInFileMode', { n: budgets.length });

  // ── MCP access ───────────────────────────────────────────────────────────
  // Access is explicit: with no env policy, no team policy and no per-key
  // grant, the intersection is empty and nobody may call any tool — the
  // opposite of the intuitive "unconfigured means unrestricted"
  // (crates/aisix-mcp/src/gateway.rs:374-380).
  const servers = rows(doc, 'mcp_servers');
  if (servers.length) {
    const anyPolicy = rows(doc, 'mcp_policies').some((p) => p.enabled !== false);
    const anyKeyGrant = rows(doc, 'api_keys').some(
      (k) => (k.mcp_access?.allow?.length ?? 0) > 0 || (k.mcp_access?.allow_ids?.length ?? 0) > 0
    );
    if (!anyPolicy && !anyKeyGrant) push('mcp_servers', 'mcpDefaultDeny', { n: servers.length });
  }

  // `allow` is required, so an empty list is not "no restriction" — it is a
  // layer that permits nothing. And `allow_ids`, when present at all, is
  // authoritative even if empty. Intending to "remove a couple of tools"
  // requires allow: ["*"] first.
  for (const p of rows(doc, 'mcp_policies')) {
    if (p.enabled === false) continue;
    const emptyIds = Array.isArray(p.allow_ids) && p.allow_ids.length === 0;
    const emptyNames = !Array.isArray(p.allow_ids) && Array.isArray(p.allow) && p.allow.length === 0;
    if (emptyIds || emptyNames) push('mcp_policies', 'mcpPolicyEmptyAllow', { scope: p.scope ?? 'env' });
  }

  // ── cache policies ───────────────────────────────────────────────────────
  // `applies_to` is parsed as a free string and anything unrecognised becomes
  // `all`, so a typo widens the policy from one model to the whole environment
  // (crates/aisix-core/src/models/cache_policy.rs:230-251). An absent value is
  // the documented default and is not flagged.
  for (const c of rows(doc, 'cache_policies')) {
    const v = c.applies_to;
    if (typeof v !== 'string' || v === '') continue;
    if (v === 'all' || v.startsWith('model:') || v.startsWith('api_key:')) continue;
    push('cache_policies', 'cacheAppliesToUnknown', { policy: label(c), value: v });
  }

  // ── rate limit policies ──────────────────────────────────────────────────
  for (const p of rows(doc, 'rate_limit_policies')) {
    const hasClassic = CLASSIC_FIELDS.some((f) => p[f] !== undefined);
    const hasCondition = CONDITION_FIELDS.some((f) => p[f] !== undefined);
    if (hasClassic && hasCondition) push('rate_limit_policies', 'rateLimitMixedForms', { name: label(p) });
    const unknown = ABSENT_RATE_FIELDS.filter((f) => p[f] !== undefined);
    if (unknown.length) {
      push('rate_limit_policies', 'rateLimitUnknownField', { name: label(p), fields: unknown.join(', ') });
    }
  }

  // ── cost attribution ─────────────────────────────────────────────────────
  // Teams and members are labels only: they take part in neither authentication
  // nor routing. A team no key points at has no effect on anything, and the
  // team-scoped rate limits and budgets written for it match no request.
  const teamIds = new Set(rows(doc, 'api_keys').map((k) => k.team_id).filter(Boolean));
  for (const t of rows(doc, 'teams')) {
    if (t.id && !teamIds.has(t.id)) push('teams', 'teamNoKey', { name: label(t) });
  }
  const userIds = new Set(rows(doc, 'api_keys').map((k) => k.user_id).filter(Boolean));
  for (const u of rows(doc, 'users')) {
    if (u.id && !userIds.has(u.id)) push('users', 'memberNoKey', { name: label(u) });
  }

  // A mapping whose provider name does not match any provider is filtered out
  // before evaluation, so tokens from that IdP always end up 401 with no clue
  // (crates/aisix-proxy/src/jwt.rs:409).
  const providerNames = new Set(rows(doc, 'oidc_providers').map((p) => p.name).filter(Boolean));
  for (const m of rows(doc, 'claim_mappings')) {
    if (m.jwt_provider && !providerNames.has(m.jwt_provider)) {
      push('claim_mappings', 'claimMappingProviderMissing', { name: label(m) });
    }
  }

  // A key scoped to a model name that does not exist gets 403 on every call,
  // while GET /v1/models comes back empty so the caller cannot see what they are
  // allowed to use. This is the trace a rename leaves when it did not propagate
  // — including when it happened in raw YAML, which has nothing to propagate
  // from. Only non-wildcard entries are judged: `*` and `provider/*` match
  // whatever exists.
  const modelNames = new Set(rows(doc, 'models').map((m) => m.display_name).filter(Boolean));
  for (const k of rows(doc, 'api_keys')) {
    // The three scoping fields are not equal: allow_all_models beats
    // allowed_model_ids beats allowed_models, so a row that uses a narrower one
    // has its allowed_models ignored and flagging it would be noise.
    if (k.allow_all_models === true || Array.isArray(k.allowed_model_ids)) continue;
    for (const m of Array.isArray(k.allowed_models) ? k.allowed_models : []) {
      if (typeof m !== 'string' || m === '' || m.includes('*')) continue;
      if (!modelNames.has(m)) push('api_keys', 'apiKeyAllowedModelUnknown', { name: label(k), model: m });
    }
  }

  // A price row nothing references is dead weight — and, more usefully, the
  // inverse mistake (a model whose pricing_key matches no row) shows up as
  // "no cost on usage events", which is much harder to notice than this.
  const usedKeys = new Set(rows(doc, 'models').map((m) => m.pricing_key).filter(Boolean));
  for (const p of rows(doc, 'pricing')) {
    if (p.key && !usedKeys.has(p.key)) push('pricing', 'pricingUnused', { key: p.key });
  }

  return out;
}
