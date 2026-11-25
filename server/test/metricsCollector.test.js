// The collector against a real (stub) exposition endpoint.
//
// Why this file exists: on a live deployment usage statistics went blank for three
// days. The gateway was fine, the network was fine, the parser was fine — the
// gateway simply emitted two series with the value `NaN`
// (`aisix_ratelimit_remaining_tokens{…} NaN` whenever that limit is unset), SQLite
// binds NaN as NULL, the `value` column is NOT NULL, the INSERT threw — and because
// one scrape is ONE transaction, the entire batch rolled back every 10 seconds,
// forever, without logging a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createMetricsCollector, finiteSamples, parseExposition } from '../src/metrics.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aisix-collector-'));
}

// What the gateway actually sends, reduced to the shapes that matter.
const EXPOSITION = [
  '# TYPE aisix_requests_total counter',
  'aisix_requests_total{outcome="success",model="m"} 7',
  'aisix_requests_total{outcome="error",model="m"} 1',
  '# TYPE aisix_llm_spend_micro_usd_total counter',
  'aisix_llm_spend_micro_usd_total 1234',
  // The two series that broke it. "Remaining" is unbounded when no limit is set.
  'aisix_ratelimit_remaining_requests{api_key_id="k",model="m"} NaN',
  'aisix_ratelimit_remaining_tokens{api_key_id="k",model="m"} NaN',
  '',
].join('\n');

async function withStubGateway(body, fn) {
  // `hits` lets a test prove how many scrapes actually happened, rather than
  // assuming a sleep was long enough.
  const seen = { hits: 0 };
  const srv = createServer((_req, res) => {
    seen.hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await fn(srv.address().port, seen);
  } finally {
    srv.close();
  }
}

async function waitFor(predicate, ms = 4000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('a NaN series does not abort the scrape — the real numbers still land', async () => {
  const dir = tmpDir();
  await withStubGateway(EXPOSITION, async (port) => {
    const collector = createMetricsCollector({
      metricsDb: path.join(dir, 'metrics.db'),
      metricsScrapeIntervalSeconds: 3600,
      metricsRetentionHours: 24,
      gateway: { metrics: `http://127.0.0.1:${port}` },
    });
    collector.start();
    assert.ok(await waitFor(() => collector.getState().lastScrapeAt != null), 'scrape never completed');
    const state = collector.getState();
    assert.equal(state.lastScrapeOk, true, `scrape failed: ${state.lastScrapeError}`);
    // The two NaN series are dropped and counted, not fatal.
    assert.equal(state.skippedNonFinite, 2);
    assert.equal(state.storedLastScrape, 3);
    // And they are genuinely absent from the store.
    const db = new DatabaseSync(path.join(dir, 'metrics.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM samples').get().c, 3);
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM samples WHERE metric LIKE '%remaining%'").get().c,
      0,
    );
    assert.equal(
      db.prepare("SELECT value FROM samples WHERE metric='aisix_requests_total' AND labels LIKE '%success%'").get().value,
      7,
    );
  });
});

test('the guard is load-bearing: SQLite stores a NaN as NULL and the column refuses it', () => {
  // If this ever stops throwing, the guard above is no longer what saves the
  // scrape — and this test should be revisited rather than deleted.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE samples (
    metric TEXT NOT NULL, labels TEXT NOT NULL, ts INTEGER NOT NULL,
    value REAL NOT NULL, PRIMARY KEY (metric, labels, ts))`);
  const insert = db.prepare('INSERT INTO samples (metric, labels, ts, value) VALUES (?,?,?,?)');
  insert.run('fine', '{}', 1, 1.5);
  assert.throws(() => insert.run('nan', '{}', 1, NaN), /NOT NULL/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM samples').get().c, 1);
});

test('finiteSamples keeps the finite values and reports what it dropped', () => {
  const parsed = parseExposition(
    ['a 1', 'b NaN', 'c +Inf', 'd -Inf', 'e 2.5', ''].join('\n'),
  );
  assert.equal(parsed.length, 5);
  const { kept, skipped } = finiteSamples(parsed);
  assert.equal(skipped, 3);
  assert.deepEqual(kept.map((s) => s.metric), ['a', 'e']);
});

test('a scrape that genuinely fails is reported, not swallowed', async () => {
  const dir = tmpDir();
  const srv = createServer((_req, res) => {
    res.writeHead(503);
    res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const collector = createMetricsCollector({
      metricsDb: path.join(dir, 'metrics.db'),
      metricsScrapeIntervalSeconds: 3600,
      metricsRetentionHours: 24,
      gateway: { metrics: `http://127.0.0.1:${srv.address().port}` },
    });
    collector.start();
    assert.ok(await waitFor(() => collector.getState().lastScrapeError != null));
    assert.equal(collector.getState().lastScrapeOk, false);
    assert.match(collector.getState().lastScrapeError, /503/);
  } finally {
    srv.close();
  }
});

// The store counters are display-only and they are NOT cheap: measured on a
// production store, the distinct-series count took 99.3 seconds and the row count
// 3.1s. Re-run on every scrape they blocked the event loop long enough that the
// console answered /api/health in 39-102s and was reported unhealthy. They must be
// computed rarely, which is what this pins.
test('the display-only store counters are not recomputed on every scrape', async () => {
  const dir = tmpDir();
  await withStubGateway(EXPOSITION, async (port, seen) => {
    const collector = createMetricsCollector({
      metricsDb: path.join(dir, 'metrics.db'),
      metricsScrapeIntervalSeconds: 1,
      metricsRetentionHours: 24,
      gateway: { metrics: `http://127.0.0.1:${port}` },
    });
    collector.start();
    assert.ok(await waitFor(() => collector.getState().statsUpdatedAt != null));
    const first = collector.getState().statsUpdatedAt;
    // Prove more scrapes than the first one really happened before asserting the
    // counter was not refreshed — otherwise this passes on a collector that died.
    assert.ok(await waitFor(() => seen.hits >= 3, 6000), `only ${seen.hits} scrape(s) happened`);
    assert.equal(
      collector.getState().statsUpdatedAt,
      first,
      'the store counters were recomputed inside the throttle window',
    );
  });
});
