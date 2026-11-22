// Guards the contract between the catalogue structure (web/src/lib/
// resourceCatalog.js) and the copy (resourceCatalog.* in both locales).
//
// WHY: this redesign exists because the page told users nothing, and the one
// hint line it did have mentioned five of the fifteen resources it displayed.
// That kind of drift is invisible — the page renders, it is just wrong or
// empty. So every claim the structure makes about a resource is asserted here
// against the strings that have to back it:
//
//   * a kind with no copy            → the card renders a blank name
//   * a column with no label         → the header falls back to the raw field
//                                      name, which is how a Chinese UI showed
//                                      "AUTH_TYPE" and "DESTINATION"
//   * a failure mode with no text    → the whole point of the band disappears
//                                      silently, in the exact place users were
//                                      told to look
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zh from '../src/i18n/locales/zh-CN.js';
import en from '../src/i18n/locales/en.js';
import {
  GROUPS,
  KINDS,
  COLS,
  RELATIONS,
  MIS_MODES,
  OWN_PAGE_NAV,
  FORM_FIELDS,
  PAGE_COLS,
} from '../src/lib/resourceCatalog.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Cross-package on purpose: the effect self-check is server-side and its codes
// are what the UI has to translate, so the two halves must be asserted
// together or a new check ships with no copy.
import { CHECK_CODES, CHECK_PARAMS } from '../../server/src/effectChecks.js';

const locales = { 'zh-CN': zh, en };

const resolve = (obj, path) =>
  path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);

const filled = (v) => typeof v === 'string' && v.trim() !== '';

const FAIL_MODES = ['file', 'row', 'silent'];

test('the catalogue covers exactly the collections the loader knows', () => {
  assert.equal(KINDS.length, 21, 'server/src/resources.js KINDS has 21 entries');
  assert.equal(new Set(KINDS.map((k) => k.key)).size, KINDS.length, 'duplicate kind key');
  for (const k of KINDS) {
    assert.ok(GROUPS.includes(k.group), `${k.key}: unknown group ${k.group}`);
  }
  // Every group must have members, or the page renders an empty section.
  for (const g of GROUPS) {
    assert.ok(KINDS.some((k) => k.group === g), `group ${g} has no kinds`);
  }
});

test('every kind answers the six questions in both locales', () => {
  // `trap` is the one-liner the card shows; `verify` is how the user confirms
  // it actually took effect. Both are part of the promise the design makes.
  const suffixes = ['label', 'oneLiner', 'whenNeeded', 'effect', 'ifAbsent', 'trap', 'verify'];
  const missing = [];
  for (const k of KINDS) {
    for (const suffix of suffixes) {
      for (const [name, loc] of Object.entries(locales)) {
        if (!filled(resolve(loc, `resourceCatalog.kind.${k.key}.${suffix}`))) {
          missing.push(`${name}: resourceCatalog.kind.${k.key}.${suffix}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `missing copy:\n${missing.join('\n')}`);
});

test('every table column has a label — no raw-field-name fallback', () => {
  const missing = [];
  // Both tables: the catalogue's own detail views, and the kinds whose table
  // lives on their owning page (Policies).
  for (const [kind, cols] of Object.entries({ ...COLS, ...PAGE_COLS })) {
    assert.ok(KINDS.some((k) => k.key === kind), `COLS names unknown kind ${kind}`);
    for (const field of cols) {
      for (const [name, loc] of Object.entries(locales)) {
        if (!filled(resolve(loc, `resourceCatalog.col.${field}`))) {
          missing.push(`${name}: resourceCatalog.col.${field} (for ${kind})`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `missing column labels:\n${missing.join('\n')}`);
});

test('PAGE_COLS covers exactly the kinds another page maintains', () => {
  // The catalogue renders no table for these, so a kind here without ownPage
  // would mean two places render the same rows.
  for (const kind of Object.keys(PAGE_COLS)) {
    const rec = KINDS.find((k) => k.key === kind);
    assert.ok(rec, `PAGE_COLS names unknown kind ${kind}`);
    assert.ok(rec.ownPage, `${kind} is in PAGE_COLS but has no owning page`);
  }
});

test('own-page kinds have no table of their own', () => {
  // Their detail view links out instead of duplicating the dedicated page's
  // table, so carrying columns here would be dead configuration.
  const wrong = Object.keys(COLS).filter((kind) => KINDS.find((k) => k.key === kind)?.ownPage);
  assert.deepEqual(wrong, [], `these have an owning page but declare columns: ${wrong.join(', ')}`);
});

test('every declared failure mode has copy, and the counts line up', () => {
  const problems = [];
  for (const k of KINDS) {
    const modes = MIS_MODES[k.key];
    assert.ok(Array.isArray(modes) && modes.length > 0, `${k.key}: no failure modes declared`);
    for (const mode of modes) {
      if (!FAIL_MODES.includes(mode)) problems.push(`${k.key}: unknown mode ${mode}`);
    }
    for (const [name, loc] of Object.entries(locales)) {
      const list = resolve(loc, `resourceCatalog.kind.${k.key}.mis`);
      if (!Array.isArray(list)) {
        problems.push(`${name}: ${k.key}.mis is not an array`);
        continue;
      }
      // A mode listed without text renders an empty row inside the band the
      // user was told to trust — worse than not listing it.
      if (list.length !== modes.length) {
        problems.push(`${name}: ${k.key}.mis has ${list.length} entries, structure declares ${modes.length}`);
      }
      list.forEach((text, i) => {
        if (!filled(text)) problems.push(`${name}: ${k.key}.mis.${i} is empty`);
      });
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the three failure modes are explained once, in both locales', () => {
  for (const mode of FAIL_MODES) {
    for (const [name, loc] of Object.entries(locales)) {
      for (const suffix of ['label', 'text']) {
        assert.ok(
          filled(resolve(loc, `resourceCatalog.fail.${mode}.${suffix}`)),
          `${name}: resourceCatalog.fail.${mode}.${suffix}`
        );
      }
    }
  }
});

test('relations name a known kind and a known identity', () => {
  for (const [kind, rels] of Object.entries(RELATIONS)) {
    assert.ok(KINDS.some((k) => k.key === kind), `RELATIONS names unknown kind ${kind}`);
    for (const r of rels) {
      assert.ok(KINDS.some((k) => k.key === r.from), `${kind} -> ${r.from}: unknown kind`);
      assert.ok(['id', 'name'].includes(r.by), `${kind} -> ${r.from}: unknown identity ${r.by}`);
      assert.ok(filled(r.field), `${kind} -> ${r.from}: empty field`);
      // The referencing kind must also be translated, since we render its label.
      for (const [name, loc] of Object.entries(locales)) {
        assert.ok(
          filled(resolve(loc, `resourceCatalog.kind.${r.from}.label`)),
          `${name}: missing label for ${r.from}`
        );
      }
    }
  }
});

test('owning pages resolve to a nav label', () => {
  for (const k of KINDS) {
    if (!k.ownPage) continue;
    const navKey = OWN_PAGE_NAV[k.ownPage];
    assert.ok(navKey, `${k.key}: ${k.ownPage} is not in OWN_PAGE_NAV`);
    for (const [name, loc] of Object.entries(locales)) {
      assert.ok(filled(resolve(loc, `app.nav.${navKey}`)), `${name}: app.nav.${navKey}`);
    }
  }
});

test('every group and the page chrome are translated', () => {
  const keys = [
    'intro', 'summaryKinds', 'guideTitle', 'guideHint', 'guideTail', 'legendTitle',
    'viewRaw', 'ownedElsewhere', 'ownedHere', 'rawOnlyBadge', 'manage', 'goTo', 'back',
    'factWhat', 'factWhen', 'factEffect', 'factAbsent', 'factLinks', 'factMis',
    'factVerify', 'factRawOnly', 'rawOnlyNote', 'relById', 'relByName', 'noRelation',
    'trapLabel', 'statusUnset', 'statusCount',
  ];
  const missing = [];
  for (const key of keys) {
    for (const [name, loc] of Object.entries(locales)) {
      if (!filled(resolve(loc, `resourceCatalog.${key}`))) missing.push(`${name}: ${key}`);
    }
  }
  for (const g of GROUPS) {
    for (const suffix of ['name', 'desc']) {
      for (const [name, loc] of Object.entries(locales)) {
        if (!filled(resolve(loc, `resourceCatalog.group.${g}.${suffix}`))) {
          missing.push(`${name}: group.${g}.${suffix}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `missing copy:\n${missing.join('\n')}`);
});

test('the kind list order matches the group list order', () => {
  // The page renders groups in GROUPS order and kinds in KINDS order, so a kind
  // filed under an earlier group than a previously listed one would jump
  // sections unexpectedly.
  const seen = new Set();
  let last = -1;
  for (const k of KINDS) {
    const idx = GROUPS.indexOf(k.group);
    assert.ok(idx >= last, `${k.key} is out of group order`);
    last = idx;
    seen.add(k.group);
  }
  assert.equal(seen.size, GROUPS.length);
});

test('every effect check has copy, and no copy is orphaned', () => {
  // Both directions: a server-side check with no translation would render a raw
  // dotted key, and a translation with no check is dead weight that hides a
  // rename on the server.
  const codes = Object.keys(zh.resourceCatalog.check ?? {}).sort();
  assert.deepEqual(codes, [...CHECK_CODES].sort(), 'resourceCatalog.check and CHECK_CODES must agree');
  for (const [name, loc] of Object.entries(locales)) {
    assert.ok(filled(resolve(loc, 'resourceCatalog.checkIntro')), `${name}: resourceCatalog.checkIntro`);
    for (const code of CHECK_CODES) {
      assert.ok(filled(resolve(loc, `resourceCatalog.check.${code}`)), `${name}: check.${code}`);
    }
  }
});

test('the placeholders in each check translation match the params the server sends', () => {  // The copy is interpolated on the client, so a translation using {count} where
  // the server sends {n} shows the user a literal "{count}".
  const problems = [];
  for (const code of CHECK_CODES) {
    const declared = [...(CHECK_PARAMS[code] ?? [])].sort();
    for (const [name, loc] of Object.entries(locales)) {
      const text = resolve(loc, `resourceCatalog.check.${code}`);
      const used = [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const unique = [...new Set(used)];
      if (JSON.stringify(unique) !== JSON.stringify(declared)) {
        problems.push(`${name}: ${code} uses ${JSON.stringify(unique)}, contract says ${JSON.stringify(declared)}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('no field copy key contains a dot', () => {
  // i18n paths use dots as the nesting separator, so a field key like
  // `anonymous.enabled` is looked up as field -> anonymous -> enabled and never
  // resolves. Nested form fields are camelCased instead.
  const bad = [];
  for (const [kind, fields] of Object.entries(FORM_FIELDS)) {
    for (const field of fields) if (field.includes('.')) bad.push(`${kind}.${field}`);
  }
  assert.deepEqual(bad, [], `field keys must not contain a dot: ${bad.join(', ')}`);
});

test('no message carries a brace that i18n would read as interpolation', () => {
  // vue-i18n's message compiler reads `{...}` as interpolation. A bare brace in a
  // curl body, a regex quantifier or a metric label makes the message unusable,
  // and the component rendering it vanishes — as a comment node, with nothing in
  // the browser console. That is exactly how the six-question band silently
  // stopped rendering for mcp_servers, teams, cache_policies and
  // rate_limit_policies. Literal braces have to be written {'{'} and {'}'}.
  const ALLOWED = /\{(?:'\{'|'\}'|[A-Za-z_][A-Za-z0-9_]*)\}/g;
  const problems = [];
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      const where = path ? `${path}.${key}` : key;
      if (typeof value === 'string') {
        if (!value.includes('{') && !value.includes('}')) continue;
        const rest = value.replace(ALLOWED, '');
        if (rest.includes('{') || rest.includes('}')) problems.push(`${where}: ${value.slice(0, 100)}`);
      } else if (value && typeof value === 'object') {
        walk(value, where);
      }
    }
  };
  for (const [name, loc] of Object.entries(locales)) walk(loc.resourceCatalog, name);
  assert.deepEqual(problems, [], `unescaped braces:\n${problems.join('\n')}`);
});

test('every field a form renders has one line of help, in both locales', () => {
  // The design's promise is one line per field: what to put there, and what
  // breaks if you get it wrong. A field with a label but no help is the halfway
  // state this whole change exists to remove.
  const missing = [];
  for (const [kind, fields] of Object.entries(FORM_FIELDS)) {
    for (const field of fields) {
      const keys = [`resourceCatalog.kind.${kind}.fieldHelp.${field}`, `resourceCatalog.fieldHelp.${field}`];
      for (const [name, loc] of Object.entries(locales)) {
        if (!keys.some((key) => filled(resolve(loc, key)))) missing.push(`${name}: ${kind}.${field}`);
      }
    }
  }
  assert.deepEqual(missing, [], `fields with no help:\n${missing.join('\n')}`);
});

test('no help copy is orphaned', () => {
  // Shared help must be rendered by some form, and per-kind help must belong to a
  // field that form actually renders. Dead copy hides a rename on the page side.
  const problems = [];
  const rendered = new Set(Object.values(FORM_FIELDS).flat());
  for (const key of Object.keys(zh.resourceCatalog.fieldHelp ?? {})) {
    if (!rendered.has(key)) problems.push(`fieldHelp.${key} is rendered by no form`);
  }
  for (const [kind, block] of Object.entries(zh.resourceCatalog.kind ?? {})) {
    for (const key of Object.keys(block?.fieldHelp ?? {})) {
      if (!FORM_FIELDS[kind]) problems.push(`kind.${kind}.fieldHelp exists but ${kind} has no form`);
      else if (!FORM_FIELDS[kind].includes(key)) {
        problems.push(`kind.${kind}.fieldHelp.${key} is not a field that form renders`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every field an inline form renders has a label in both locales', () => {
  // Label resolution is a fallback chain: the per-kind override, then the shared
  // field.*, then the table-column label col.*. A gap anywhere in the chain is
  // what used to put `auth_type` and `bound_claims (JSON)` in front of a user.
  const missing = [];
  for (const [kind, fields] of Object.entries(FORM_FIELDS)) {
    assert.ok(KINDS.some((k) => k.key === kind), `FORM_FIELDS names unknown kind ${kind}`);
    for (const field of fields) {
      const candidates = [
        `resourceCatalog.kind.${kind}.field.${field}`,
        `resourceCatalog.field.${field}`,
        `resourceCatalog.col.${field}`,
      ];
      for (const [name, loc] of Object.entries(locales)) {
        if (!candidates.some((key) => filled(resolve(loc, key)))) {
          missing.push(`${name}: ${kind}.${field} (tried ${candidates.join(' / ')})`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `fields with no label:\n${missing.join('\n')}`);
});

test('the form template and FORM_FIELDS describe the same fields', () => {
  // The mirror check. The test above proves the structure has copy; this one
  // proves the page actually asks for that copy — a label the template renders
  // but the structure omits is never checked for translation, and one the
  // structure lists but the template dropped is dead weight.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '../src/views/Resources.vue'), 'utf8');
  const inTemplate = new Map();
  // Kind keys contain digits (`a2a_agents`), hence [a-z0-9_].
  for (const m of src.matchAll(/FL\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'([^']+)'\s*\)/g)) {
    const [, kind, field] = m;
    if (!inTemplate.has(kind)) inTemplate.set(kind, new Set());
    inTemplate.get(kind).add(field);
  }
  assert.ok(inTemplate.size > 0, 'no FL() calls found — did the labels get reverted to raw keys?');

  const problems = [];
  for (const [kind, fields] of Object.entries(FORM_FIELDS)) {
    const seen = inTemplate.get(kind) ?? new Set();
    for (const field of fields) {
      if (!seen.has(field)) problems.push(`FORM_FIELDS lists ${kind}.${field} but the template does not render it`);
    }
    for (const field of seen) {
      if (!fields.includes(field)) problems.push(`the template renders ${kind}.${field} but FORM_FIELDS omits it`);
    }
  }
  for (const kind of inTemplate.keys()) {
    if (!FORM_FIELDS[kind]) problems.push(`the template renders fields for unknown kind ${kind}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('no raw configuration key is left as a form label', () => {
  // The regression guard for this whole change: `<label>auth_type</label>`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '../src/views/Resources.vue'), 'utf8');
  const raw = [...src.matchAll(/<label>\s*([a-z][a-z0-9_]*(?:\.[a-z_]+)*)\s*\*?\s*<\/label>/g)].map((m) => m[1]);
  assert.deepEqual(raw, [], `labels still showing the configuration key: ${raw.join(', ')}`);
});
