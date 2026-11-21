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

test('toIdReferences leaves an unresolvable name alone rather than inventing an id', () => {
  const doc = assignIds({ ...V1_DOC, models: [{ display_name: 'm', provider_key: 'nope' }] });
  const out = toIdReferences(doc);
  assert.equal(out.models[0].provider_key, 'nope');
  assert.equal(out.models[0].provider_key_id, undefined);
});

test('migrateToV2 produces a v2 doc with ids and id references, and is idempotent', () => {
  const once = migrateToV2(V1_DOC);
  assert.equal(once._format_version, FORMAT_VERSION_V2);
  assert.equal(once.models[0].provider_key_id, deriveId('provider_keys', 'codebuddy'));
  assert.ok(once.provider_keys.every((r) => typeof r.id === 'string' && r.id.length === 36));
  const twice = migrateToV2(once);
  assert.deepEqual(twice, once);
});

test('migrateToV2 keeps collections it does not manage', () => {
  const out = migrateToV2({ ...V1_DOC, pricing: [{ name: 'p' }], global: { teams: [{ name: 't' }] } });
  assert.deepEqual(out.pricing, [{ name: 'p' }]);
  assert.deepEqual(out.global.teams, [{ name: 't' }]);
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
