// Guards on the resources files this repository SHIPS.
//
// Both are consumed by machines, not humans, and both break silently when their
// format drifts:
//
//   deploy/resources.template.yaml  — seeded into a fresh data dir by run.sh
//     (and, all-empty, by the console's own bootstrap). A gateway >= 1.11
//     refuses to START on a v1 file, so a stale template turns "fresh install"
//     into a crash loop.
//   deploy/resources.ci-sample.yaml — the input to CI's schema-drift gate. A v1
//     file makes that gate fail the whole build (which is exactly how the
//     mismatch was found: the pinned gateway reached 1.11 while the sample was
//     still v1).
//
// Both are pinned to the CURRENT format here, and the template is pinned to the
// code that generates it, so the two cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { bootstrapTemplate, serialize, formatVersionOf, FORMAT_VERSION_V2, KINDS } from '../src/resources.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = (f) => path.join(here, '..', '..', 'deploy', f);
const read = (f) => parse(fs.readFileSync(deploy(f), 'utf8'), { uniqueKeys: true });

test('the shipped resources template is format v2', () => {
  const doc = read('resources.template.yaml');
  assert.equal(formatVersionOf(doc), FORMAT_VERSION_V2);
});

test('the shipped template matches what bootstrapTemplate() generates', () => {
  // Byte-comparable: both go through the same serializer.
  assert.equal(
    fs.readFileSync(deploy('resources.template.yaml'), 'utf8'),
    serialize(bootstrapTemplate()),
  );
});

test('the template scaffolds every registered kind', () => {
  const doc = read('resources.template.yaml');
  for (const kind of KINDS) {
    assert.ok(Array.isArray(doc[kind]), `${kind} missing from the template`);
  }
});

test('the CI sample is format v2 with an id on every row', () => {
  const doc = read('resources.ci-sample.yaml');
  assert.equal(formatVersionOf(doc), FORMAT_VERSION_V2);
  let rows = 0;
  for (const kind of KINDS) {
    const entries = doc[kind];
    if (!Array.isArray(entries)) continue;
    for (const [i, row] of entries.entries()) {
      rows++;
      // v2 requires the resource UUID as a file field; the loader strips it
      // before decoding, so the schema does not mention it.
      assert.match(
        String(row?.id ?? ''),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        `${kind}[${i}] needs a lowercase hyphenated uuid id`,
      );
    }
  }
  assert.ok(rows > 0, 'the CI sample should exercise at least one row');
});
