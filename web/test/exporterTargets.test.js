// Unit tests for the observability-exporter target catalogue and wire mapping.
//
// These pin the behaviours that were broken or missing in the old form:
//   - `tags` must be a JSON ARRAY (Vec<String>); the old form defaulted it to
//     `{}`, so a new Datadog exporter could never pass validation.
//   - `content_max_bytes` applies to Datadog too, but the old form never
//     rendered it.
//   - the endpoint constraints that reject a plain-HTTP self-hosted collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOtlpEndpoint,
  validateSlsEndpoint,
  validateDatadogSite,
  validateObjectStoreEndpoint,
  validateContentMaxBytes,
  validateSampleRate,
  validateDraft,
  parseTags,
  formatTags,
  parseHeaders,
  formatHeaders,
  buildEntry,
  draftFromEntry,
  defaultDraft,
  destinationOf,
  DATADOG_SITES,
} from '../src/lib/exporterTargets.js';

test('otlp endpoint accepts https and the local collector allowlist', () => {
  assert.equal(validateOtlpEndpoint('https://api.honeycomb.io/v1/traces'), null);
  assert.equal(validateOtlpEndpoint('http://localhost:4318/v1/traces'), null);
  assert.equal(validateOtlpEndpoint('http://otel-collector:4318/v1/traces'), null);
  assert.equal(validateOtlpEndpoint('http://127.0.0.1:4318'), null);
});

test('otlp endpoint rejects plain http to a non-allowlisted host (the real trap)', () => {
  // A self-hosted collector named `tempo` is NOT on the gateway's allowlist.
  assert.equal(validateOtlpEndpoint('http://tempo:4318/v1/traces'), 'otlpHttpNeedsHttps');
  assert.equal(validateOtlpEndpoint('tempo:4318'), 'otlpBadUrl');
  assert.equal(validateOtlpEndpoint(''), 'required');
});

test('sls endpoint is host-only and says so when a scheme is pasted', () => {
  assert.equal(validateSlsEndpoint('ap-southeast-3.log.aliyuncs.com'), null);
  assert.equal(validateSlsEndpoint('https://ap-southeast-3.log.aliyuncs.com'), 'slsHostOnly');
  assert.equal(validateSlsEndpoint('log.aliyuncs.com:443'), 'slsBadHost');
  assert.equal(validateSlsEndpoint(''), 'required');
});

test('datadog site is a closed enum', () => {
  for (const s of DATADOG_SITES) assert.equal(validateDatadogSite(s), null);
  assert.equal(validateDatadogSite('datadoghq.org'), 'ddBadSite');
  assert.equal(validateDatadogSite('localhost:8123'), null);
  assert.equal(validateDatadogSite(''), 'required');
});

test('object_store endpoint is optional and rejects non-allowlisted http', () => {
  assert.equal(validateObjectStoreEndpoint(''), null);
  assert.equal(validateObjectStoreEndpoint('http://minio:9000'), null);
  assert.equal(validateObjectStoreEndpoint('https://s3.example.com'), null);
  assert.equal(validateObjectStoreEndpoint('http://my-s3:9000'), 'objStoreHttpNeedsHttps');
});

test('numeric bounds mirror the gateway ranges', () => {
  assert.equal(validateContentMaxBytes('131072'), null);
  assert.equal(validateContentMaxBytes(''), null);
  assert.equal(validateContentMaxBytes('0'), 'outOfRange');
  assert.equal(validateContentMaxBytes('1048577'), 'outOfRange');
  assert.equal(validateContentMaxBytes('abc'), 'badInt');
  assert.equal(validateSampleRate('0.25'), null);
  assert.equal(validateSampleRate('1'), null);
  assert.equal(validateSampleRate('1.5'), 'outOfRange');
  assert.equal(validateSampleRate('x'), 'badNumber');
});

test('reference tags and headers', () => {
  assert.deepEqual(parseTags('team:platform, tier:prod'), ['team:platform', 'tier:prod']);
  assert.deepEqual(parseTags('a\nb'), ['a', 'b']);
  assert.equal(parseTags('   '), undefined);
  assert.equal(formatTags(['a', 'b']), 'a, b');
  assert.equal(formatTags(undefined), '');

  // Values may contain colons — split on the FIRST one only.
  assert.deepEqual(parseHeaders('Authorization: Bearer a:b\nx-team: abc'), {
    Authorization: 'Bearer a:b',
    'x-team': 'abc',
  });
  assert.deepEqual(parseHeaders('# comment\n\n'), undefined);
  assert.equal(formatHeaders({ a: 'b' }), 'a: b');
});

test('buildEntry maps Datadog tags to an ARRAY (regression: used to send {})', () => {
  const e = buildEntry({
    ...defaultDraft('datadog'),
    name: 'dd',
    service: 'gw',
    credential_ref: 'dd-prod',
    tags_text: 'team:platform, tier:prod',
  });
  assert.deepEqual(e.tags, ['team:platform', 'tier:prod']);
  assert.equal(Array.isArray(e.tags), true);
});

test('buildEntry omits tags entirely when the field is empty (never sends {})', () => {
  const e = buildEntry({
    ...defaultDraft('datadog'),
    name: 'dd',
    service: 'gw',
    credential_ref: 'dd-prod',
    tags_text: '',
  });
  assert.equal('tags' in e, false);
  // content_max_bytes defaults to the gateway's own 128 KiB, so sending it is
  // equivalent to omitting it — and it makes the effective cap visible.
  assert.equal(e.content_max_bytes, 131072);
});

test('buildEntry exposes Datadog content_max_bytes (was missing from the old form)', () => {
  const e = buildEntry({
    ...defaultDraft('datadog'),
    name: 'dd',
    service: 'gw',
    credential_ref: 'dd-prod',
    content_mode: 'full',
    content_max_bytes: '4096',
  });
  assert.equal(e.content_max_bytes, 4096);
  assert.equal(e.content_mode, 'full');
});

test('buildEntry emits only the fields of the chosen kind (deny_unknown_fields)', () => {
  const otlp = buildEntry({ ...defaultDraft('otlp_http'), name: 'x', endpoint: 'https://a/v1/traces' });
  for (const forbidden of ['site', 'project', 'bucket', 'credential_ref']) {
    assert.equal(forbidden in otlp, false, `otlp_http must not carry ${forbidden}`);
  }

  const sls = buildEntry({
    ...defaultDraft('aliyun_sls'),
    name: 's',
    endpoint: 'ap-southeast-3.log.aliyuncs.com',
    project: 'p',
    logstore: 'l',
    credential_ref: 'r',
  });
  for (const forbidden of ['site', 'bucket', 'headers', 'sample_rate']) {
    assert.equal(forbidden in sls, false, `aliyun_sls must not carry ${forbidden}`);
  }
});

test('buildEntry drops blank optional fields rather than sending empty strings', () => {
  const e = buildEntry({
    ...defaultDraft('object_store'),
    name: 'o',
    bucket: 'b',
    prefix: 'p',
    credential_ref: 'r',
    region: '   ',
    endpoint: '',
  });
  assert.equal('region' in e, false);
  assert.equal('endpoint' in e, false);
});

test('buildEntry omits credential_ref under cloud_identity', () => {
  const e = buildEntry({
    ...defaultDraft('object_store'),
    name: 'o',
    bucket: 'b',
    prefix: 'p',
    auth_mode: 'cloud_identity',
    credential_ref: 'left-over-value',
  });
  assert.equal('credential_ref' in e, false);
  assert.equal(e.auth_mode, 'cloud_identity');
});

test('validateDraft reports per-field errors and clears when fixed', () => {
  const bad = validateDraft({
    ...defaultDraft('aliyun_sls'),
    name: '',
    endpoint: 'https://ap-southeast-3.log.aliyuncs.com',
    project: '',
    logstore: 'l',
    credential_ref: '',
  });
  assert.equal(bad.name, 'required');
  assert.equal(bad.endpoint, 'slsHostOnly');
  assert.equal(bad.project, 'required');
  assert.equal(bad.credential_ref, 'required');
  assert.equal('logstore' in bad, false);

  const good = validateDraft({
    ...defaultDraft('aliyun_sls'),
    name: 'sls',
    endpoint: 'ap-southeast-3.log.aliyuncs.com',
    project: 'p',
    logstore: 'l',
    credential_ref: 'sls-prod',
  });
  assert.deepEqual(good, {});
});

test('validateDraft rejects cloud_identity on azure_blob only', () => {
  const azure = validateDraft({
    ...defaultDraft('object_store'),
    name: 'o',
    bucket: 'b',
    prefix: 'p',
    provider: 'azure_blob',
    auth_mode: 'cloud_identity',
  });
  assert.equal(azure.auth_mode, 'cloudIdentityS3GcsOnly');

  const s3 = validateDraft({
    ...defaultDraft('object_store'),
    name: 'o',
    bucket: 'b',
    prefix: 'p',
    provider: 's3',
    auth_mode: 'cloud_identity',
  });
  assert.equal('auth_mode' in s3, false);
});

test('draftFromEntry round-trips through buildEntry', () => {
  const entry = {
    name: 'dd',
    enabled: true,
    kind: 'datadog',
    site: 'datadoghq.eu',
    credential_ref: 'dd-prod',
    service: 'gw',
    ddsource: 'aisix-ai-gateway',
    tags: ['env:prod'],
    content_mode: 'full',
    content_max_bytes: 2048,
  };
  const draft = draftFromEntry(entry, 'datadog');
  assert.equal(draft.tags_text, 'env:prod');
  assert.deepEqual(buildEntry(draft), entry);
});

test('destinationOf answers "where does it send" for every kind', () => {
  assert.equal(destinationOf({ kind: 'otlp_http', endpoint: 'https://x/v1/traces' }), 'https://x/v1/traces');
  assert.equal(destinationOf({ kind: 'datadog', site: 'datadoghq.eu' }), 'Datadog · datadoghq.eu');
  assert.equal(destinationOf({ kind: 'aliyun_sls', endpoint: 'ap1.log.aliyuncs.com' }), 'SLS · ap1.log.aliyuncs.com');
  assert.equal(
    destinationOf({ kind: 'object_store', provider: 's3', bucket: 'b', prefix: 'p' }),
    's3://b/p',
  );
});
