// Guards against the "raw i18n key shown to the user" failure: every static
// `t('a.b.c')` in the exporter UI must resolve in BOTH locales, plus the keys
// that are built dynamically (validator error codes, target card labels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zh from '../src/i18n/locales/zh-CN.js';
import en from '../src/i18n/locales/en.js';
import { TARGETS } from '../src/lib/exporterTargets.js';
import {
  validateName,
  validateOtlpEndpoint,
  validateSlsEndpoint,
  validateDatadogSite,
  validateObjectStoreEndpoint,
  validateContentMaxBytes,
  validateSampleRate,
} from '../src/lib/exporterTargets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  '../src/components/ExporterForm.vue',
  '../src/components/ExporterHealth.vue',
  '../src/components/FormatBanner.vue',
  '../src/views/Resources.vue',
  '../src/views/Metrics.vue',
];

// Only the blocks this suite owns; other pages' keys are exercised by their own
// usage and would just duplicate the check.
const OWNED_PREFIXES = ['obs.', 'fmt.', 'resources.', 'metrics.'];

const locales = { 'zh-CN': zh, en };

function resolve(obj, keyPath) {
  return keyPath.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function staticKeysIn(file) {
  const src = readFileSync(path.join(here, file), 'utf8');
  const keys = new Set();
  // Only complete literals: `t('a.b')`. A concatenation such as
  // `t('obs.err.' + code)` is dynamic and is covered by the error-code test.
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'\s*\)/g)) keys.add(m[1]);
  return keys;
}

test('every static t() key in the exporter UI resolves in both locales', () => {
  const missing = [];
  for (const file of FILES) {
    for (const key of staticKeysIn(file)) {
      // Only assert on keys we own; other pages' keys are covered by their own
      // usage and would just duplicate this check.
      if (!OWNED_PREFIXES.some((p) => key.startsWith(p))) continue;
      for (const [name, locale] of Object.entries(locales)) {
        const v = resolve(locale, key);
        if (typeof v !== 'string' || v === '') missing.push(`${name}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], `missing i18n keys:\n${missing.join('\n')}`);
});

test('all target card labels and descriptions are translated', () => {
  const missing = [];
  for (const tg of TARGETS) {
    for (const key of [tg.labelKey, tg.descKey]) {
      for (const [name, locale] of Object.entries(locales)) {
        const v = resolve(locale, key);
        if (typeof v !== 'string' || v === '') missing.push(`${name}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every validator error code has a translation (obs.err.*)', () => {
  // Drive the validators with inputs chosen to trigger each code, so a new
  // error code added to the lib cannot silently ship without copy.
  const codes = new Set();
  const collect = (code) => {
    if (code) codes.add(code);
  };
  collect(validateName(''));
  collect(validateName('x'.repeat(121)));
  collect(validateOtlpEndpoint(''));
  collect(validateOtlpEndpoint('http://tempo:4318'));
  collect(validateOtlpEndpoint('not-a-url'));
  collect(validateSlsEndpoint(''));
  collect(validateSlsEndpoint('https://x.log.aliyuncs.com'));
  collect(validateSlsEndpoint('bad host'));
  collect(validateDatadogSite(''));
  collect(validateDatadogSite('datadoghq.org'));
  collect(validateObjectStoreEndpoint('http://my-s3:9000'));
  collect(validateContentMaxBytes('0'));
  collect(validateContentMaxBytes('nope'));
  collect(validateSampleRate('2'));
  collect(validateSampleRate('nope'));
  // cloudIdentityS3GcsOnly only comes out of validateDraft.
  codes.add('cloudIdentityS3GcsOnly');

  assert.ok(codes.size >= 11, `expected a broad set of codes, got ${[...codes].join(',')}`);

  const missing = [];
  for (const code of codes) {
    for (const [name, locale] of Object.entries(locales)) {
      const v = resolve(locale, `obs.err.${code}`);
      if (typeof v !== 'string' || v === '') missing.push(`${name}: obs.err.${code}`);
    }
  }
  assert.deepEqual(missing, [], `missing error copy:\n${missing.join('\n')}`);
});

test('keys referenced dynamically resolve too', () => {
  // These are built at runtime (a column-label map, a snippet tab prefix), so
  // the static scan above cannot see them. List them explicitly.
  const dynamic = [
    'obs.colDestination',
    'obs.colContent',
    'obs.credCompose',
    'obs.credDockerRun',
    'obs.credDotenv',
  ];
  const missing = [];
  for (const key of dynamic) {
    for (const [name, locale] of Object.entries(locales)) {
      const v = resolve(locale, key);
      if (typeof v !== 'string' || v === '') missing.push(`${name}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('both locales define the same obs.* / fmt.* key set', () => {
  const flatten = (obj, prefix = '') => {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') out.push(...flatten(v, key));
      else out.push(key);
    }
    return out;
  };
  for (const block of ['obs', 'fmt', 'resources', 'metrics']) {
    const zhKeys = flatten(zh[block]).sort();
    const enKeys = flatten(en[block]).sort();
    const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
    const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
    assert.deepEqual(onlyZh, [], `${block}: zh-only keys: ${onlyZh.join(', ')}`);
    assert.deepEqual(onlyEn, [], `${block}: en-only keys: ${onlyEn.join(', ')}`);
  }
});
