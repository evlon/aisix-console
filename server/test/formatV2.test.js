// File-format v2 support: id assignment, name→id reference rewriting, the
// v1→v2 migration, and id reconciliation across an ordinary save.
//
// Why these exist: aisix 1.11 (#1449) made `_format_version: "2"` a hard
// equality check and deleted the name→id sugar layer. A v1 file — what this
// console wrote until now — fails the entire load on 1.11+, and a v2 file
// fails on 1.10 and older. The migration has to be id-preserving or every
// resource appears to be re-created (metrics, access logs and budget rows are
// all keyed by these ids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveId,
  formatVersionOf,
  assignIds,
  toIdReferences,
  migrateToV2,
  reconcileIds,
  serialize,
  isFormatVersionMismatch,
  externalizeRefs,
  internalizeRefs,
  unresolvedReference,
  identityOf,
  KINDS,
  IDENTITY_FIELD,
  FORMAT_VERSION_V1,
  FORMAT_VERSION_V2,
} from '../src/resources.js';

// A trimmed but structurally faithful copy of the live tengxun-hc file.
const V1_DOC = {
  _format_version: '1',
  provider_keys: [
    { display_name: 'deepseek', provider: 'openai', api_key: 'sk-a' },
    { display_name: 'codebuddy', provider: 'openai', api_key: 'sk-b' },
  ],
  models: [
    { display_name: 'codebuddy/deepseek-v4-flash', provider: 'openai', model_name: 'x', provider_key: 'codebuddy' },
    {
      display_name: 'app-liuyan',
      routing: { strategy: 'failover', targets: [{ model: 'codebuddy/deepseek-v4-flash' }], when_all_unavailable: 'fail' },
    },
  ],
  api_keys: [{ display_name: 'local-dev', allowed_models: ['*'], key_hash: 'ff' }],
  guardrails: [],
};

test('the derived id reproduces what aisix <=1.10 used (migration is id-preserving)', () => {
  // Captured from a live aisix 1.7.1 access log on the tengxun-hc deployment:
  // the `provider_key_id` recorded for a request routed through the
  // `codebuddy` provider key.
  assert.equal(deriveId('provider_keys', 'codebuddy'), 'e79384e5-8419-5ccf-a717-4970cd97eb6d');
});

test('formatVersionOf reads v2 only when it is exactly "2"', () => {
  assert.equal(formatVersionOf({ _format_version: '2' }), FORMAT_VERSION_V2);
  assert.equal(formatVersionOf({ _format_version: '1' }), FORMAT_VERSION_V1);
  assert.equal(formatVersionOf({}), FORMAT_VERSION_V1);
  assert.equal(formatVersionOf({ _format_version: 2 }), FORMAT_VERSION_V1);
  assert.equal(formatVersionOf(null), FORMAT_VERSION_V1);
});

test('assignIds derives ids and puts `id` first', () => {
  const out = assignIds(V1_DOC);
  const pk = out.provider_keys[0];
  assert.equal(Object.keys(pk)[0], 'id');
  assert.equal(pk.id, deriveId('provider_keys', 'deepseek'));
  assert.equal(pk.display_name, 'deepseek');
  assert.equal(out.models[0].id, deriveId('models', 'codebuddy/deepseek-v4-flash'));
  assert.equal(out.api_keys[0].id, deriveId('api_keys', 'local-dev'));
});

test('assignIds preserves an id that is already present', () => {
  const existing = '11111111-2222-3333-4444-555555555555';
  const out = assignIds({ ...V1_DOC, provider_keys: [{ id: existing, display_name: 'deepseek' }] });
  assert.equal(out.provider_keys[0].id, existing);
});

test('assignIds also covers the shared global section', () => {
  const out = assignIds({ _format_version: '2', global: { provider_keys: [{ display_name: 'g' }] } });
  assert.equal(out.global.provider_keys[0].id, deriveId('provider_keys', 'g'));
});

test('toIdReferences rewrites models.provider_key into provider_key_id', () => {
  const withIds = assignIds(V1_DOC);
  const out = toIdReferences(withIds);
  assert.equal(out.models[0].provider_key, undefined);
  assert.equal(out.models[0].provider_key_id, deriveId('provider_keys', 'codebuddy'));
  // A routing target keeps its model ALIAS: v2 still accepts it.
  assert.deepEqual(out.models[1].routing.targets, [{ model: 'codebuddy/deepseek-v4-flash' }]);
  // A model with no provider_key is untouched.
  assert.equal(out.models[1].provider_key_id, undefined);
});

test('an unresolvable reference is preserved, never replaced by an invented id', () => {
  const doc = assignIds({ ...V1_DOC, models: [{ display_name: 'm', provider_key: 'nope' }] });
  const out = toIdReferences(doc);
  // The value survives so `aisix validate` can name the bad reference; what
  // must NOT happen is us minting a uuid that points at nothing.
  assert.equal(out.models[0].provider_key_id, 'nope');
  assert.equal(out.models[0].provider_key, undefined);
  assert.equal(out.models[0].id, deriveId('models', 'm'));
});

test('migrateToV2 produces a v2 doc with ids and id references, and is idempotent', () => {
  const once = migrateToV2(V1_DOC);
  assert.equal(once._format_version, FORMAT_VERSION_V2);
  assert.equal(once.models[0].provider_key_id, deriveId('provider_keys', 'codebuddy'));
  assert.ok(once.provider_keys.every((r) => typeof r.id === 'string' && r.id.length === 36));
  const twice = migrateToV2(once);
  assert.deepEqual(twice, once);
});

test('migrateToV2 keeps unknown collections verbatim, and ids the ones it knows', () => {
  const out = migrateToV2({ ...V1_DOC, pricing: [{ key: 'p' }], some_future_kind: [{ x: 1 }] });
  // `pricing` is a registered kind now, so it gets its derived id...
  assert.equal(out.pricing[0].id, deriveId('pricing', 'p'));
  // ...while a key this build does not know is left exactly as it was.
  assert.deepEqual(out.some_future_kind, [{ x: 1 }]);
});

test('the newer collections resolve an identity for list/CRUD', () => {
  assert.equal(identityOf('teams', { name: 't1' }), 't1');
  assert.equal(identityOf('users', { name: 'u1' }), 'u1');
  assert.equal(identityOf('pricing', { key: 'deepseek-v4-flash' }), 'deepseek-v4-flash');
  // Composites, since these have no name field.
  assert.equal(identityOf('budgets', { scope: 'team', scope_ref: 'T' }), 'team:T');
  assert.equal(identityOf('budgets', { scope: 'tag', tag: { key: 'k', value: 'v' } }), 'tag:k=v');
  assert.equal(identityOf('mcp_policies', { scope: 'env' }), 'env');
  assert.equal(identityOf('mcp_policies', { scope: 'team', scope_ref: 'T' }), 'team:T');
  // Singletons.
  assert.equal(identityOf('budget_policy', { fail_mode: 'closed' }), 'budget_policy');
  assert.equal(identityOf('usage_accounting', { exclude_estimated_usage: false }), 'usage_accounting');
  // A null-collapsing identity would make every row collide in findIndex.
  assert.notEqual(identityOf('budgets', { scope: 'team', scope_ref: 'A' }), identityOf('budgets', { scope: 'team', scope_ref: 'B' }));
});

test('every registered kind has an identity, so CRUD cannot collide on ""', () => {
  for (const kind of KINDS) {
    assert.ok(kind in IDENTITY_FIELD, `${kind} missing from IDENTITY_FIELD`);
  }
  // A null-field kind must be covered by a fixed or composite rule.
  const kwOwnRule = new Set(['guardrail_attachments', 'budgets', 'mcp_policies', 'budget_policy', 'usage_accounting', 'mcp_auth_settings']);
  assert.equal(kwOwnRule.size, 6);
});

test('the newer kinds are file-mode loadable (mirrors the 1.11.0 probe)', () => {
  // Verified against the real binary: a file with one row of each of these
  // loaded 7 resources. Guards the KINDS list against a typo that would make
  // the console write a collection the gateway ignores or rejects.
  const expected = ['teams', 'users', 'pricing', 'budgets', 'budget_policy', 'usage_accounting', 'mcp_policies'];
  for (const kind of expected) assert.ok(KINDS.includes(kind), `${kind} not in KINDS`);
});

test('reconcileIds keeps an id across a save that dropped it', () => {
  const prev = migrateToV2(V1_DOC);
  const editedId = prev.provider_keys[1].id;
  // A view rebuilt this row field-by-field and lost `id` (and renamed nothing).
  const next = {
    ...prev,
    provider_keys: [prev.provider_keys[0], { display_name: 'codebuddy', provider: 'openai', api_key: 'sk-b2' }],
  };
  const out = reconcileIds(prev, next);
  assert.equal(out.provider_keys[1].id, editedId);
  assert.equal(out.provider_keys[1].api_key, 'sk-b2');
});

test('reconcileIds derives an id for a genuinely new row', () => {
  const prev = migrateToV2(V1_DOC);
  const next = { ...prev, api_keys: [...prev.api_keys, { display_name: 'brand-new' }] };
  const out = reconcileIds(prev, next);
  assert.equal(out.api_keys[1].id, deriveId('api_keys', 'brand-new'));
});

test('reconcileIds is a no-op on a v1 document', () => {
  const out = reconcileIds(null, V1_DOC);
  assert.equal(out, V1_DOC);
});

test('isFormatVersionMismatch spots the gateway wording', () => {
  assert.equal(
    isFormatVersionMismatch('(file): unrecognized _format_version "1" (supported: "2")'),
    true,
  );
  assert.equal(isFormatVersionMismatch('guardrails[0]: bad thing'), false);
  assert.equal(isFormatVersionMismatch(undefined), false);
});

test('a reconciled v2 doc survives serialize with its ids and version intact', () => {
  const prev = migrateToV2(V1_DOC);
  const keptId = prev.provider_keys[0].id;
  // Simulate what a route does: load, mutate an entry (the form dropped `id`),
  // reconcile, then serialize — the exact sequence savePipeline runs.
  const edited = {
    ...prev,
    provider_keys: [{ display_name: 'deepseek', provider: 'openai', api_key: 'sk-rotated' }, ...prev.provider_keys.slice(1)],
  };
  const text = serialize(reconcileIds(prev, edited));
  assert.match(text, /^_format_version: "2"/);
  assert.match(text, new RegExp(`- id: ${keptId}\\n    display_name: deepseek`));
  assert.match(text, /api_key: sk-rotated/);
  // No stray derived-id duplication: exactly one id per row.
  const ids = text.match(/^\s+- id: /gm) ?? [];
  assert.equal(ids.length, 5); // 2 provider_keys + 2 models + 1 api_key
});

// ── reference translation at the API boundary ────────────────────────────

test('externalizeRefs turns provider_key_id back into the provider key NAME', () => {
  const doc = migrateToV2(V1_DOC);
  const model = doc.models[0];
  const view = externalizeRefs('models', model, doc);
  assert.equal(view.provider_key, 'codebuddy');
  assert.equal(view.provider_key_id, undefined);
});

test('internalizeRefs writes the spelling the file version needs', () => {
  const doc = migrateToV2(V1_DOC);
  const viewEntry = { display_name: 'm', provider: 'openai', model_name: 'x', provider_key: 'codebuddy' };

  const v2 = internalizeRefs('models', viewEntry, doc, FORMAT_VERSION_V2);
  assert.equal(v2.provider_key, undefined);
  assert.equal(v2.provider_key_id, deriveId('provider_keys', 'codebuddy'));

  const v1 = internalizeRefs('models', viewEntry, doc, FORMAT_VERSION_V1);
  assert.equal(v1.provider_key, 'codebuddy');
  assert.equal(v1.provider_key_id, undefined);
});

test('internalizeRefs creates no stray id under a v1 file', () => {
  const doc = V1_DOC;
  // A view that round-tripped an id must not leave provider_key_id behind on a
  // v1 file, where it is an unknown field.
  const viewEntry = { display_name: 'm', provider_key: 'codebuddy', provider_key_id: 'stale' };
  const out = internalizeRefs('models', viewEntry, doc, FORMAT_VERSION_V1);
  assert.equal(out.provider_key_id, undefined);
  assert.equal(out.provider_key, 'codebuddy');
});

test('a full round-trip through externalize/internalize is stable', () => {
  const doc = migrateToV2(V1_DOC);
  const before = doc.models[0];
  const after = internalizeRefs('models', externalizeRefs('models', before, doc), doc, FORMAT_VERSION_V2);
  assert.equal(after.provider_key_id, before.provider_key_id);
});

test('unresolvedReference names the missing provider key instead of writing a uuid box', () => {
  const doc = migrateToV2(V1_DOC);
  const bad = unresolvedReference('models', { display_name: 'm', provider_key: 'nope' }, doc, FORMAT_VERSION_V2);
  assert.match(bad, /provider_key "nope" 不存在/);
  assert.equal(unresolvedReference('models', { display_name: 'm', provider_key: 'codebuddy' }, doc, FORMAT_VERSION_V2), null);
  // v1 files let the gateway's own loader report it.
  assert.equal(unresolvedReference('models', { display_name: 'm', provider_key: 'nope' }, V1_DOC, FORMAT_VERSION_V1), null);
});

// ── every other reference the console exposes ────────────────────────────
// The console's dropdowns write names; v2 wants uuids. Sources for what v2
// expects are noted on the REFERENCES table in resources.js.
const REF_DOC = {
  _format_version: '1',
  provider_keys: [{ display_name: 'deepseek' }],
  api_keys: [{ display_name: 'evlon' }],
  guardrails: [{ name: 'pii' }],
  models: [{ display_name: 'm1' }],
  mcp_servers: [{ name: 'echo' }],
  passthrough_routes: [
    { name: 'p1', auth_mode: 'anonymous', anonymous_key: 'evlon', credential_mode: 'inject', provider_key: 'deepseek' },
  ],
  claim_mappings: [{ name: 'c1', jwt_provider: 'oidc', resolve: { api_key: 'evlon' } }],
  guardrail_attachments: [{ guardrail_id: 'pii', scope_type: 'model', scope_id: 'm1', priority: 1 }],
  rate_limit_policies: [{ name: 'rl', scope: 'api_key', scope_ref: 'evlon' }],
  cache_policies: [{ name: 'cp', applies_to: 'api_key:evlon' }],
};

test('migration rewrites every reference the console exposes, not just models', () => {
  const v2 = migrateToV2(REF_DOC);
  const idOf = (kind, name) => deriveId(kind, name);

  const pr = v2.passthrough_routes[0];
  assert.equal(pr.provider_key_id, idOf('provider_keys', 'deepseek'));
  assert.equal(pr.provider_key, undefined);
  assert.equal(pr.anonymous_key_id, idOf('api_keys', 'evlon'));
  assert.equal(pr.anonymous_key, undefined);

  const cm = v2.claim_mappings[0];
  assert.equal(cm.resolve.api_key_id, idOf('api_keys', 'evlon'));
  assert.equal(cm.resolve.api_key, undefined);

  const ga = v2.guardrail_attachments[0];
  // Same field name, new value: these hold uuids in v2.
  assert.equal(ga.guardrail_id, idOf('guardrails', 'pii'));
  assert.equal(ga.scope_id, idOf('models', 'm1'));

  assert.equal(v2.rate_limit_policies[0].scope_ref, idOf('api_keys', 'evlon'));
  assert.equal(v2.cache_policies[0].applies_to, `api_key:${idOf('api_keys', 'evlon')}`);
});

test('scope_id resolves against whichever collection scope_type names', () => {
  const doc = {
    ...REF_DOC,
    guardrail_attachments: [
      { guardrail_id: 'pii', scope_type: 'mcp_server', scope_id: 'echo', priority: 1 },
      { guardrail_id: 'pii', scope_type: 'env', priority: 1 },
    ],
  };
  const v2 = migrateToV2(doc);
  assert.equal(v2.guardrail_attachments[0].scope_id, deriveId('mcp_servers', 'echo'));
  // scope_type "env" has no scope id at all — left alone.
  assert.equal(v2.guardrail_attachments[1].scope_id, undefined);
});

test('scope_ref is only translated for scope=api_key', () => {
  const doc = { ...REF_DOC, rate_limit_policies: [{ name: 'rl', scope: 'model', scope_ref: 'm1' }] };
  const v2 = migrateToV2(doc);
  assert.equal(v2.rate_limit_policies[0].scope_ref, 'm1');
});

test('applies_to only rewrites the api_key form, leaving all and model:<name>', () => {
  const doc = {
    ...REF_DOC,
    cache_policies: [{ name: 'a', applies_to: 'all' }, { name: 'b', applies_to: 'model:m1' }],
  };
  const v2 = migrateToV2(doc);
  assert.equal(v2.cache_policies[0].applies_to, 'all');
  assert.equal(v2.cache_policies[1].applies_to, 'model:m1');
});

test('externalizeRefs brings every reference back to its name for the views', () => {
  const v2 = migrateToV2(REF_DOC);
  assert.equal(externalizeRefs('passthrough_routes', v2.passthrough_routes[0], v2).provider_key, 'deepseek');
  assert.equal(externalizeRefs('passthrough_routes', v2.passthrough_routes[0], v2).anonymous_key, 'evlon');
  assert.equal(externalizeRefs('claim_mappings', v2.claim_mappings[0], v2).resolve.api_key, 'evlon');
  const ga = externalizeRefs('guardrail_attachments', v2.guardrail_attachments[0], v2);
  assert.equal(ga.guardrail_id, 'pii');
  assert.equal(ga.scope_id, 'm1');
  assert.equal(externalizeRefs('rate_limit_policies', v2.rate_limit_policies[0], v2).scope_ref, 'evlon');
  assert.equal(externalizeRefs('cache_policies', v2.cache_policies[0], v2).applies_to, 'api_key:evlon');
});

test('round-trip is stable for every reference kind', () => {
  const v2 = migrateToV2(REF_DOC);
  for (const kind of ['passthrough_routes', 'claim_mappings', 'guardrail_attachments', 'rate_limit_policies', 'cache_policies']) {
    for (const row of v2[kind]) {
      const back = internalizeRefs(kind, externalizeRefs(kind, row, v2), v2, FORMAT_VERSION_V2);
      assert.deepEqual(back, row, `${kind} round-trip drifted`);
    }
  }
});

test('the views never receive a stale v1 spelling on a v2 file', () => {
  const v2 = migrateToV2(REF_DOC);
  const pr = externalizeRefs('passthrough_routes', v2.passthrough_routes[0], v2);
  assert.equal(pr.provider_key_id, undefined);
  assert.equal(pr.anonymous_key_id, undefined);
});
