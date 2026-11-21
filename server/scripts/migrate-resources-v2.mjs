#!/usr/bin/env node
// Migrate a resources file from format v1 ("sugar") to format v2
// (etcd-document rows), which aisix >= 1.11 requires.
//
// Why a script and not just the UI: on a deployment still running aisix 1.10
// the console must keep writing v1, so migrating has to be a deliberate act.
// This is also the tool to run BEFORE pointing a v1 file at a v1.11+ gateway,
// because such a file fails the entire load (not one row).
//
// The migration is id-preserving: each row's id is derived with the same uuid5
// scheme aisix <= 1.10 used, so provider_key_id / api_key_id values already
// recorded in metrics, access logs and budget accounting keep naming the same
// resource.
//
// Usage:
//   node server/scripts/migrate-resources-v2.mjs resources.yaml            # print
//   node server/scripts/migrate-resources-v2.mjs resources.yaml out.yaml   # write
//   node server/scripts/migrate-resources-v2.mjs --in-place resources.yaml # rewrite
import fs from 'node:fs';
import {
  formatVersionOf,
  migrateToV2,
  serialize,
  loadFile,
  FORMAT_VERSION_V2,
} from '../src/resources.js';

function usage(code = 1) {
  process.stderr.write(
    'usage: migrate-resources-v2.mjs [--in-place] <input.yaml> [output.yaml]\n',
  );
  process.exit(code);
}

const argv = process.argv.slice(2);
const inPlace = argv.includes('--in-place');
const positional = argv.filter((a) => a !== '--in-place');
if (positional.length < 1) usage();
const [input, output] = positional;
if (inPlace && output) usage();

const res = loadFile(input);
if (!res.ok) {
  process.stderr.write(`cannot read ${input}: ${res.error}\n`);
  process.exit(2);
}

const version = formatVersionOf(res.doc);
if (version === FORMAT_VERSION_V2) {
  process.stderr.write(`${input} is already _format_version "2" — nothing to do\n`);
  process.exit(0);
}

const migrated = migrateToV2(res.doc);
const text = serialize(migrated);

const target = inPlace ? input : output;
if (target) {
  fs.writeFileSync(target, text, 'utf8');
  const rows = Object.values(migrated)
    .filter(Array.isArray)
    .reduce((n, a) => n + a.length, 0);
  process.stderr.write(
    `migrated ${input} -> ${target} (_format_version "1" -> "2", ${rows} row(s) given an id)\n`,
  );
} else {
  process.stdout.write(text);
}
