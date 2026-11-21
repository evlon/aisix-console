// Unit tests for the exporter credential-reference mapping.
//
// The slug rule is copied from the gateway, so these tests pin the exact
// behaviour that matters and that a naive reuse of secrets.js#slugFrom would
// get WRONG: the gateway folds each non-alphanumeric byte to `_` without
// collapsing runs or trimming. Run with `npm test -w server`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialSlug,
  requiredEnvVars,
  checkEnv,
  credentialPlan,
} from '../src/exporterCreds.js';

test('credentialSlug mirrors the gateway folding rule', () => {
  assert.equal(credentialSlug('sls-prod'), 'SLS_PROD');
  assert.equal(credentialSlug('sls.prod'), 'SLS_PROD');
  assert.equal(credentialSlug('sls prod'), 'SLS_PROD');
  assert.equal(credentialSlug('a1-B'), 'A1_B');
});

test('credentialSlug does NOT collapse runs or trim (differs from secrets.slugFrom)', () => {
  // secrets.js#slugFrom would produce 'A_B' / 'ABC'; the gateway produces these.
  assert.equal(credentialSlug('a__b'), 'A__B');
  assert.equal(credentialSlug('-abc-'), '_ABC_');
  assert.equal(credentialSlug('a---b'), 'A___B');
});

test('credentialSlug folds each non-ASCII character to one underscore', () => {
  // Rust iterates chars(); both CJK characters fold independently.
  assert.equal(credentialSlug('中文'), '__');
  assert.equal(credentialSlug('foo/bar'), 'FOO_BAR');
});

test('credentialSlug handles the empty and missing reference', () => {
  assert.equal(credentialSlug(''), '');
  assert.equal(credentialSlug(undefined), '');
  assert.equal(credentialSlug(null), '');
});

test('aliyun_sls needs AK_ID + AK_SECRET under SLS_CRED', () => {
  const { vars } = requiredEnvVars({ kind: 'aliyun_sls', ref: 'sls-prod' });
  assert.deepEqual(
    vars.map((v) => v.name),
    ['SLS_CRED_SLS_PROD_AK_ID', 'SLS_CRED_SLS_PROD_AK_SECRET'],
  );
  assert.ok(vars.every((v) => v.required));
});

test('datadog needs one API key under DD_CRED', () => {
  const { vars } = requiredEnvVars({ kind: 'datadog', ref: 'dd-prod' });
  assert.deepEqual(
    vars.map((v) => v.name),
    ['DD_CRED_DD_PROD_API_KEY'],
  );
});

test('object_store s3 has two required vars plus an optional session token', () => {
  const { vars } = requiredEnvVars({ kind: 'object_store', ref: 'acme', provider: 's3' });
  assert.deepEqual(
    vars.map((v) => [v.name, v.required]),
    [
      ['OBJSTORE_CRED_ACME_AWS_ACCESS_KEY_ID', true],
      ['OBJSTORE_CRED_ACME_AWS_SECRET_ACCESS_KEY', true],
      ['OBJSTORE_CRED_ACME_AWS_SESSION_TOKEN', false],
    ],
  );
});

test('object_store gcs and azure_blob use their own fields', () => {
  assert.deepEqual(
    requiredEnvVars({ kind: 'object_store', ref: 'r', provider: 'gcs' }).vars.map((v) => v.name),
    ['OBJSTORE_CRED_R_GCS_SERVICE_ACCOUNT_KEY'],
  );
  assert.deepEqual(
    requiredEnvVars({ kind: 'object_store', ref: 'r', provider: 'azure_blob' }).vars.map((v) => v.name),
    ['OBJSTORE_CRED_R_AZURE_ACCOUNT', 'OBJSTORE_CRED_R_AZURE_ACCESS_KEY'],
  );
});

test('otlp_http needs no environment variable (auth rides in headers)', () => {
  const { vars, note } = requiredEnvVars({ kind: 'otlp_http', ref: 'whatever' });
  assert.deepEqual(vars, []);
  assert.match(note, /headers/);
});

test('cloud_identity needs no env vars, and is rejected for azure_blob', () => {
  assert.deepEqual(
    requiredEnvVars({ kind: 'object_store', ref: 'x', provider: 's3', authMode: 'cloud_identity' }).vars,
    [],
  );
  const azure = requiredEnvVars({
    kind: 'object_store',
    ref: 'x',
    provider: 'azure_blob',
    authMode: 'cloud_identity',
  });
  assert.deepEqual(azure.vars, []);
  assert.match(azure.note, /只支持 s3 \/ gcs/);
});

test('an empty reference lists nothing and asks for one', () => {
  const { vars, note } = requiredEnvVars({ kind: 'datadog', ref: '  ' });
  assert.deepEqual(vars, []);
  assert.match(note, /引用名/);
});

test('checkEnv reports presence without exposing values', () => {
  const { vars } = requiredEnvVars({ kind: 'aliyun_sls', ref: 'sls-prod' });
  const checked = checkEnv(vars, { SLS_CRED_SLS_PROD_AK_ID: 'AKIAEXAMPLE' });
  assert.equal(checked[0].set, true);
  assert.equal(checked[1].set, false);
  // The value must not ride along on the object we hand back to the UI.
  assert.equal(JSON.stringify(checked).includes('AKIAEXAMPLE'), false);
  // A blank value does not count as set (the gateway's resolvers reject blanks).
  const blank = checkEnv(vars, { SLS_CRED_SLS_PROD_AK_ID: '', SLS_CRED_SLS_PROD_AK_SECRET: 'x' });
  assert.equal(blank[0].set, false);
});

test('credentialPlan flags allRequiredSet only when every required var is present', () => {
  const partial = credentialPlan(
    { kind: 'aliyun_sls', ref: 'sls-prod' },
    { SLS_CRED_SLS_PROD_AK_ID: 'a' },
  );
  assert.equal(partial.allRequiredSet, false);
  assert.equal(partial.slug, 'SLS_PROD');

  const full = credentialPlan(
    { kind: 'aliyun_sls', ref: 'sls-prod' },
    { SLS_CRED_SLS_PROD_AK_ID: 'a', SLS_CRED_SLS_PROD_AK_SECRET: 'b' },
  );
  assert.equal(full.allRequiredSet, true);
});

test('credentialPlan emits paste-ready snippets naming only required vars', () => {
  const plan = credentialPlan({ kind: 'datadog', ref: 'dd prod' }, {});
  assert.equal(plan.snippets.dotenv, 'DD_CRED_DD_PROD_API_KEY=');
  assert.match(plan.snippets.compose, /- DD_CRED_DD_PROD_API_KEY=<Datadog API Key>/);
  assert.match(plan.snippets.dockerRun, /-e DD_CRED_DD_PROD_API_KEY=<Datadog API Key>/);
  // Never emit a value, only the name.
  assert.equal(plan.snippets.dotenv.includes('='), true);
  assert.equal(/DD_CRED_DD_PROD_API_KEY=.+/.test(plan.snippets.dotenv), false);
});

test('credentialPlan has no snippets when nothing is required', () => {
  const plan = credentialPlan({ kind: 'otlp_http', ref: 'x' }, {});
  assert.equal(plan.snippets, null);
  assert.equal(plan.allRequiredSet, false);
});
