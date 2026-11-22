// The reported bug: renaming a model in the UI left every key's `allowed_models`
// on the old name, so the old name 404'd (looks deleted), the new name 403'd
// (looks like a permission problem) and GET /v1/models came back empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameModelReferences, propagateModelRename } from '../src/modelRename.js';

test('the reported case: allowed_models follows the rename', () => {
  const doc = {
    api_keys: [
      { display_name: 'a', allowed_models: ['dsv41'] },
      { display_name: 'b', allowed_models: ['*'] },
      { display_name: 'c', allowed_models: ['dsv41', 'other'] },
    ],
  };
  const changed = renameModelReferences(doc, 'dsv41', 'deepseek-v4.1-flash');
  assert.deepEqual(doc.api_keys[0].allowed_models, ['deepseek-v4.1-flash']);
  assert.deepEqual(doc.api_keys[2].allowed_models, ['deepseek-v4.1-flash', 'other']);
  assert.deepEqual(changed, ['api_keys[0].allowed_models[0]', 'api_keys[2].allowed_models[0]']);
});

test('wildcards are left alone', () => {
  // `*` and `provider/*` match the model under either name; rewriting them would
  // corrupt the pattern.
  const doc = { api_keys: [{ display_name: 'b', allowed_models: ['*', 'openai/*', 'dsv41*'] }] };
  renameModelReferences(doc, 'dsv41', 'new');
  assert.deepEqual(doc.api_keys[0].allowed_models, ['*', 'openai/*', 'dsv41*']);
});

test('model-to-model references follow the rename', () => {
  const doc = {
    models: [
      {
        display_name: 'router',
        routing: { strategy: 'least_cost', targets: [{ model: 'dsv41' }, { model: 'other' }] },
      },
      {
        display_name: 'panel-model',
        ensemble: { panel: [{ model: 'dsv41' }], judge: { model: 'dsv41' } },
      },
      {
        display_name: 'semantic-model',
        semantic: { routes: [{ name: 'r', target: 'dsv41' }], default: 'dsv41', embedding_model: 'dsv41' },
      },
    ],
  };
  const changed = renameModelReferences(doc, 'dsv41', 'newname');
  assert.equal(doc.models[0].routing.targets[0].model, 'newname');
  assert.equal(doc.models[0].routing.targets[1].model, 'other');
  assert.equal(doc.models[1].ensemble.panel[0].model, 'newname');
  assert.equal(doc.models[1].ensemble.judge.model, 'newname');
  assert.equal(doc.models[2].semantic.routes[0].target, 'newname');
  assert.equal(doc.models[2].semantic.default, 'newname');
  assert.equal(doc.models[2].semantic.embedding_model, 'newname');
  assert.equal(changed.length, 6);
});

test('a cache policy scoped to the model follows the rename, prefix intact', () => {
  const doc = { cache_policies: [{ name: 'c', applies_to: 'model:dsv41' }] };
  renameModelReferences(doc, 'dsv41', 'newname');
  assert.equal(doc.cache_policies[0].applies_to, 'model:newname');
});

test('a cache policy scoped to something else is untouched', () => {
  const doc = { cache_policies: [{ name: 'c', applies_to: 'api_key:dsv41' }, { name: 'd', applies_to: 'all' }] };
  renameModelReferences(doc, 'dsv41', 'newname');
  assert.equal(doc.cache_policies[0].applies_to, 'api_key:dsv41');
  assert.equal(doc.cache_policies[1].applies_to, 'all');
});

test('nothing changes when the name is the same or missing', () => {
  const doc = { api_keys: [{ allowed_models: ['dsv41'] }] };
  assert.deepEqual(renameModelReferences(doc, 'dsv41', 'dsv41'), []);
  assert.deepEqual(doc.api_keys[0].allowed_models, ['dsv41']);
  assert.deepEqual(renameModelReferences(doc, '', 'x'), []);
  assert.deepEqual(renameModelReferences(doc, 'dsv41', ''), []);
  assert.deepEqual(doc.api_keys[0].allowed_models, ['dsv41']);
});

test('propagateModelRename only acts when the display name changed', () => {
  const doc = { api_keys: [{ allowed_models: ['dsv41'] }] };
  assert.deepEqual(propagateModelRename(doc, { display_name: 'dsv41' }, { display_name: 'dsv41' }), []);
  assert.deepEqual(doc.api_keys[0].allowed_models, ['dsv41']);
  assert.deepEqual(propagateModelRename(doc, { display_name: 'dsv41' }, { display_name: 'new' }), [
    'api_keys[0].allowed_models[0]',
  ]);
  assert.deepEqual(doc.api_keys[0].allowed_models, ['new']);
});

test('malformed rows are skipped rather than throwing', () => {
  const doc = {
    api_keys: [null, 'not-an-object', { allowed_models: 'not-a-list' }, { allowed_models: [null, 'dsv41'] }],
    models: [{ routing: null }, { routing: { targets: 'not-an-array' } }, { semantic: { default: 42 } }],
    cache_policies: [null, { applies_to: 42 }],
  };
  const changed = renameModelReferences(doc, 'dsv41', 'new');
  assert.deepEqual(changed, ['api_keys[3].allowed_models[1]']);
  assert.deepEqual(doc.api_keys[3].allowed_models, [null, 'new']);
});

test('an empty document is fine', () => {
  assert.deepEqual(renameModelReferences({}, 'a', 'b'), []);
  assert.deepEqual(renameModelReferences(null, 'a', 'b'), []);
});
