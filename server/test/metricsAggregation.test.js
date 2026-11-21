// Aggregation correctness for the usage store.
//
// The case that matters most is the one that was silently wrong: a window that
// starts BEFORE the store's retention. The baseline sample is gone, and the old
// code treated "no baseline" as 0 — so a 24h/7d view over a 1h-retention store
// reported the counter's lifetime total as if it were that window's usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb,
  counterDelta,
  counterBreakdown,
  latestGaugesByLabel,
  latestGauge,
  storeCoverage,
} from '../src/metrics.js';

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aisix-metrics-')), 'metrics.db');
  return { db: openDb(file), file };
}

// Insert one series, mimicking the collector's minute-bucketed writes.
function series(db, metric, labels, points) {
  const stmt = db.prepare('INSERT OR REPLACE INTO samples (metric, labels, ts, value) VALUES (?,?,?,?)');
  const key = JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1))));
  for (const [ts, value] of points) stmt.run(metric, key, ts, value);
}

const M = 'aisix_llm_total_tokens_total';

test('a window with its baseline present reports the true delta', () => {
  const { db } = tmpDb();
  series(db, M, { model: 'a' }, [[100, 1000], [160, 1250], [220, 1400]]);
  // from=100 is in the store, so the delta is measured, not guessed.
  assert.equal(counterDelta(db, M, null, 100, 220), 400);
  assert.equal(counterDelta(db, M, null, 160, 220), 150);
});

test('a window older than retention no longer reports the lifetime total', () => {
  const { db } = tmpDb();
  // Store only holds the last hour; the counter already read 5000 when the
  // earliest retained sample was taken.
  series(db, M, { model: 'a' }, [[1000, 5000], [1060, 5200], [1120, 5500]]);

  // A 24h window (from far before retention).
  const got = counterDelta(db, M, null, 1000 - 86400, 1120);
  // Correct: only what is visible in the retained window (5500 - 5000 = 500).
  assert.equal(got, 500);
  // The old behaviour would have been 5500 — the counter's whole life.
  assert.notEqual(got, 5500);
});

test('a series whose first sample is inside the window counts from that sample', () => {
  const { db } = tmpDb();
  series(db, M, { model: 'a' }, [[1060, 5200], [1120, 5500]]);
  assert.equal(counterDelta(db, M, null, 1000, 1120), 300);
});

test('filtering by label still applies with a pruned baseline', () => {
  const { db } = tmpDb();
  series(db, M, { model: 'a' }, [[1060, 100], [1120, 400]]);
  series(db, M, { model: 'b' }, [[1060, 900], [1120, 900]]);
  assert.equal(counterDelta(db, M, { model: 'a' }, 1000, 1120), 300);
  assert.equal(counterDelta(db, M, { model: 'b' }, 1000, 1120), 0);
});

test('counter resets are clamped, not turned negative', () => {
  const { db } = tmpDb();
  // Gateway restarted: the counter went backwards.
  series(db, M, { model: 'a' }, [[100, 900], [160, 40], [220, 90]]);
  assert.equal(counterDelta(db, M, null, 100, 220), 0);
  assert.equal(counterDelta(db, M, null, 160, 220), 50);
});

test('counterBreakdown groups by label and applies the same baseline rule', () => {
  const { db } = tmpDb();
  series(db, M, { model: 'a' }, [[1060, 100], [1120, 400]]);
  series(db, M, { model: 'b' }, [[1060, 10], [1120, 60]]);
  const rows = counterBreakdown(db, M, 'model', 1000, 1120);
  assert.deepEqual(rows, [{ key: 'a', value: 300 }, { key: 'b', value: 50 }]);
});

test('storeCoverage reports what the store actually holds', () => {
  const { db } = tmpDb();
  series(db, M, { model: 'a' }, [[1000, 1], [1120, 2]]);
  assert.deepEqual(storeCoverage(db), { from: 1000, to: 1120 });
  assert.deepEqual(storeCoverage(db, M), { from: 1000, to: 1120 });
  assert.deepEqual(storeCoverage(db, 'nope'), { from: null, to: null });
});

test('latestGaugesByLabel returns the newest sample of every label set', () => {
  const { db } = tmpDb();
  const G = 'aisix_budget_remaining_usd';
  series(db, G, { api_key_id: 'k1' }, [[100, 10], [200, 7]]);
  series(db, G, { api_key_id: 'k2' }, [[150, 3], [200, 2.5]]);
  const rows = latestGaugesByLabel(db, G).sort((a, b) => (a.labels.api_key_id < b.labels.api_key_id ? -1 : 1));
  assert.deepEqual(rows.map((r) => [r.labels.api_key_id, r.value]), [['k1', 7], ['k2', 2.5]]);
  // The single-value helper only ever sees one of them, which is why the
  // per-label variant exists.
  assert.equal(typeof latestGauge(db, G, null), 'number');
});

test('latestGaugesByLabel honours a label filter', () => {
  const { db } = tmpDb();
  const G = 'aisix_budget_limit_usd';
  series(db, G, { team_id: 't1', api_key_id: 'k1' }, [[100, 5]]);
  series(db, G, { team_id: 't2', api_key_id: 'k2' }, [[100, 9]]);
  const rows = latestGaugesByLabel(db, G, { team_id: 't2' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 9);
});

// aisix_llm_tokens_by_client_total carries input / output / total as three
// SEPARATE series over the same tokens. Reading them together is the easiest
// way to triple a number in this file, so the filter is pinned here.
test('the by-client token breakdown counts each token_type exactly once', () => {
  const { db } = tmpDb();
  const C = 'aisix_llm_tokens_by_client_total';
  // One client, one model: input 100, output 40, total 140 (total INCLUDES both).
  series(db, C, { client_type: 'cursor', model: 'm', token_type: 'input' }, [[100, 100], [160, 300]]);
  series(db, C, { client_type: 'cursor', model: 'm', token_type: 'output' }, [[100, 40], [160, 90]]);
  series(db, C, { client_type: 'cursor', model: 'm', token_type: 'total' }, [[100, 140], [160, 390]]);

  const total = counterBreakdown(db, C, 'client_type', 100, 160, { token_type: 'total' });
  const input = counterBreakdown(db, C, 'client_type', 100, 160, { token_type: 'input' });
  const output = counterBreakdown(db, C, 'client_type', 100, 160, { token_type: 'output' });

  assert.deepEqual(total, [{ key: 'cursor', value: 250 }]);
  assert.deepEqual(input, [{ key: 'cursor', value: 200 }]);
  assert.deepEqual(output, [{ key: 'cursor', value: 50 }]);
  // The hazard: summing all three series would read 500 for 250 tokens.
  const unfiltered = counterBreakdown(db, C, 'client_type', 100, 160);
  assert.equal(unfiltered[0].value, 500);
  assert.notEqual(total[0].value, unfiltered[0].value);
});

test('a second client is reported separately, not merged', () => {
  const { db } = tmpDb();
  const C = 'aisix_llm_tokens_by_client_total';
  series(db, C, { client_type: 'cursor', model: 'm', token_type: 'total' }, [[100, 10], [160, 60]]);
  series(db, C, { client_type: 'claude-cli', model: 'm', token_type: 'total' }, [[100, 5], [160, 25]]);
  const rows = counterBreakdown(db, C, 'client_type', 100, 160, { token_type: 'total' });
  assert.deepEqual(rows, [{ key: 'cursor', value: 50 }, { key: 'claude-cli', value: 20 }]);
});
