// The regression this suite exists for: a form-shaped PUT deleted every field
// the form did not model. rate_limit {rpm,tpm,concurrency,rpd,tpd} came back as
// {rpm}, with HTTP 200 and "saved" on screen — the token cap that stops one
// caller consuming the whole quota, gone on a rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEntry, preservedPaths } from '../src/entryMerge.js';

test('a field the submission does not mention is kept', () => {
  const stored = { display_name: 'k', rate_limit: { rpm: 600, tpm: 400000, concurrency: 8 } };
  const submitted = { display_name: 'k', rate_limit: { rpm: 600 } };
  assert.deepEqual(mergeEntry(stored, submitted), {
    display_name: 'k',
    rate_limit: { rpm: 600, tpm: 400000, concurrency: 8 },
  });
});

test('the exact reported case: rebuilding rate_limit keeps the token caps', () => {
  const stored = {
    display_name: 'niukunliang',
    key_hash: 'aa',
    allowed_models: ['dsv41'],
    rate_limit: { rpm: 600, tpm: 400000, concurrency: 8, rpd: 20000, tpd: 20000000 },
  };
  // What the API-key form sent before tpm/tpd existed on it.
  const submitted = { display_name: 'niukunliang', key_hash: 'aa', allowed_models: ['dsv41'], rate_limit: { rpm: 600 } };
  assert.deepEqual(mergeEntry(stored, submitted).rate_limit, {
    rpm: 600,
    tpm: 400000,
    concurrency: 8,
    rpd: 20000,
    tpd: 20000000,
  });
});

test('an explicit null deletes, so merging does not make a field unclearable', () => {
  const stored = { display_name: 'k', rate_limit: { rpm: 600, tpm: 400000 }, expires_at: '2026-01-01T00:00:00Z' };
  const submitted = { display_name: 'k', rate_limit: { rpm: 600, tpm: null }, expires_at: null };
  assert.deepEqual(mergeEntry(stored, submitted), { display_name: 'k', rate_limit: { rpm: 600 } });
});

test('arrays replace rather than merge, or removing a list entry would be impossible', () => {
  const stored = { allowed_models: ['a', 'b', 'c'] };
  assert.deepEqual(mergeEntry(stored, { allowed_models: ['a'] }), { allowed_models: ['a'] });
  assert.deepEqual(mergeEntry(stored, { allowed_models: [] }), { allowed_models: [] });
});

test('scalars replace, including false and zero', () => {
  assert.deepEqual(mergeEntry({ enabled: true, n: 5 }, { enabled: false }), { enabled: false, n: 5 });
  assert.deepEqual(mergeEntry({ n: 5 }, { n: 0 }), { n: 0 });
  assert.deepEqual(mergeEntry({ s: 'a' }, { s: '' }), { s: '' });
});

test('a scalar replaces an object and vice versa', () => {
  assert.deepEqual(mergeEntry({ a: { deep: 1 } }, { a: 2 }), { a: 2 });
  assert.deepEqual(mergeEntry({ a: 2 }, { a: { deep: 1 } }), { a: { deep: 1 } });
});

test('nested objects merge at every level', () => {
  const stored = { a: { b: { keep: 1, change: 0 }, keepSibling: 2 } };
  const submitted = { a: { b: { change: 9 } } };
  assert.deepEqual(mergeEntry(stored, submitted), { a: { b: { keep: 1, change: 9 }, keepSibling: 2 } });
});

test('a key the submission introduces is added', () => {
  assert.deepEqual(mergeEntry({ a: 1 }, { a: 1, b: 2 }), { a: 1, b: 2 });
});

test('non-object inputs are handled without throwing', () => {
  assert.deepEqual(mergeEntry(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeEntry({ a: 1 }, null), undefined);
  assert.deepEqual(mergeEntry([1, 2], { a: 1 }), { a: 1 });
  assert.deepEqual(mergeEntry({ a: 1 }, [1, 2]), [1, 2]);
});

test('preservedPaths reports the leaves the merge kept', () => {
  const stored = { display_name: 'k', rate_limit: { rpm: 600, tpm: 400000, concurrency: 8 } };
  const submitted = { display_name: 'k', rate_limit: { rpm: 600 } };
  assert.deepEqual(preservedPaths(stored, submitted), ['rate_limit.tpm', 'rate_limit.concurrency']);
});

test('preservedPaths says nothing about fields the submission set or deleted', () => {
  const stored = { a: 1, b: 2, c: { d: 3 } };
  // `b` is being set, `c` is being deleted on purpose: neither is "preserved".
  assert.deepEqual(preservedPaths(stored, { a: 1, b: 2, c: null }), []);
});

test('preservedPaths reports a whole array or object that was not mentioned', () => {
  const stored = { allowed_models: ['a'], mcp_access: { allow: ['*'] } };
  assert.deepEqual(preservedPaths(stored, {}), ['allowed_models', 'mcp_access.allow']);
});

test('preservedPaths never returns values', () => {
  // provider_keys.api_key and mcp_servers.secret are plaintext in this file; a
  // save response must not become a way to read them back.
  const stored = { api_key: 'sk-super-secret', nested: { secret: 'hunter2' } };
  const paths = preservedPaths(stored, {});
  assert.deepEqual(paths, ['api_key', 'nested.secret']);
  assert.ok(!JSON.stringify(paths).includes('sk-super-secret'));
  assert.ok(!JSON.stringify(paths).includes('hunter2'));
});

test('preservedPaths is bounded, so one save cannot return a huge list', () => {
  const stored = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
  assert.equal(preservedPaths(stored, {}, 20).length, 20);
});
