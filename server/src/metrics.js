// Prometheus metrics: exposition parser + periodic scraper + SQLite store +
// windowed aggregation. The gateway's `/metrics` is a plain scrape endpoint
// (counters/gauges/histograms at scrape time), so we capture snapshots and
// compute interval usage from counter deltas. Uses Node's built-in `node:sqlite`
// — no native dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fetchWithTimeout } from './gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const METRICS_TIMEOUT_MS = 5000;

// ---- range helpers ----------------------------------------------------------
export const RANGES = {
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
};

export function parseRange(range) {
  return RANGES[range] ?? RANGES['1h'];
}

export function bucketSizeForRange(seconds) {
  if (seconds <= RANGES['15m']) return 60;
  if (seconds <= RANGES['1h']) return 120;
  if (seconds <= RANGES['6h']) return 600;
  if (seconds <= RANGES['24h']) return 1800;
  return 7200;
}

// ---- exposition parser ------------------------------------------------------
function parseLabels(str) {
  const out = {};
  const re = /(\w+)="((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return out;
}

function parseValue(s) {
  const v = s.trim();
  if (v === '+Inf') return Infinity;
  if (v === '-Inf') return -Infinity;
  if (v === 'NaN') return NaN;
  return Number(v);
}

// Parse a Prometheus text exposition into [{ metric, labels, value, type }].
export function parseExposition(text) {
  const out = [];
  const metricType = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const t = line.match(/^# TYPE (\S+) (\w+)/);
      if (t) metricType[t[1]] = t[2];
      continue;
    }
    const brace = line.indexOf('{');
    let metric;
    let labels = {};
    let rest;
    if (brace === -1) {
      const sp = line.lastIndexOf(' ');
      metric = line.slice(0, sp);
      rest = line.slice(sp + 1);
    } else {
      metric = line.slice(0, brace);
      const close = line.lastIndexOf('}');
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    }
    out.push({ metric, labels, value: parseValue(rest), type: metricType[metric] });
  }
  return out;
}

function canonicalLabels(labels) {
  const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify(sorted);
}

function minusLe(labels) {
  const { le, ...rest } = labels;
  return canonicalLabels(rest);
}

// ---- store ------------------------------------------------------------------
function openDb(dbFile) {
  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(
    `CREATE TABLE IF NOT EXISTS samples (
       metric TEXT NOT NULL,
       labels TEXT NOT NULL,
       ts INTEGER NOT NULL,
       value REAL NOT NULL,
       PRIMARY KEY (metric, labels, ts)
     );
     CREATE INDEX IF NOT EXISTS idx_samples_metric_ts ON samples (metric, ts);`,
  );
  return db;
}

// ---- aggregation ------------------------------------------------------------
// All aggregation reads are bounded by the window and run per distinct series;
// the gateway emit surfaces are tiny in personal setups.

function latestAt(db, metric, labelsKey, ts) {
  const row = db
    .prepare('SELECT value FROM samples WHERE metric = ? AND labels = ? AND ts <= ? ORDER BY ts DESC LIMIT 1')
    .get(metric, labelsKey, ts);
  return row ? row.value : null;
}

function distinctSeriesInWindow(db, metric, from, to) {
  const rows = db
    .prepare('SELECT DISTINCT labels FROM samples WHERE metric = ? AND ts BETWEEN ? AND ?')
    .all(metric, from, to);
  return rows.map((r) => r.labels);
}

function seriesInWindowWithPrefetch(db, metric, from, to) {
  // Returns Map<labelsKey, { points: [{ts,value}], startValue }>
  const series = new Map();
  const rows = db
    .prepare('SELECT labels, ts, value FROM samples WHERE metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
    .all(metric, from, to);
  for (const { labels, ts, value } of rows) {
    if (!series.has(labels)) series.set(labels, { points: [], startValue: null });
    series.get(labels).points.push({ ts, value });
  }
  for (const [labels, s] of series) {
    const v = latestAt(db, metric, labels, from);
    s.startValue = v == null ? (s.points[0]?.value ?? 0) : v;
  }
  return series;
}

function labelsMatch(labelsObj, filter) {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (labelsObj[k] !== v) return false;
  }
  return true;
}

// Total counter delta across all series (optionally filtered) over [from,to].
// Counter resets (end < start) are clamped to 0.
export function counterDelta(db, metric, labelsFilter, from, to) {
  let total = 0;
  for (const labelsKey of distinctSeriesInWindow(db, metric, from, to)) {
    const obj = JSON.parse(labelsKey);
    if (!labelsMatch(obj, labelsFilter)) continue;
    const end = latestAt(db, metric, labelsKey, to);
    const start = latestAt(db, metric, labelsKey, from);
    if (end == null) continue;
    const base = start == null ? 0 : start;
    const d = end - base;
    total += d > 0 ? d : 0;
  }
  return total;
}

// Counter delta per distinct value of `groupLabel`, descending by delta.
export function counterBreakdown(db, metric, groupLabel, from, to, extraFilter = {}) {
  const map = new Map();
  for (const labelsKey of distinctSeriesInWindow(db, metric, from, to)) {
    const obj = JSON.parse(labelsKey);
    if (!labelsMatch(obj, extraFilter)) continue;
    const end = latestAt(db, metric, labelsKey, to);
    const start = latestAt(db, metric, labelsKey, from);
    if (end == null) continue;
    const base = start == null ? 0 : start;
    const d = end - base;
    if (d < 0) continue;
    const key = obj[groupLabel] ?? 'unknown';
    map.set(key, (map.get(key) ?? 0) + d);
  }
  return [...map.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

export function latestGauge(db, metric, labelsFilter) {
  const rows = db
    .prepare('SELECT labels, ts, value FROM samples WHERE metric = ? ORDER BY ts DESC')
    .all(metric);
  for (const r of rows) {
    const obj = JSON.parse(r.labels);
    if (labelsMatch(obj, labelsFilter)) return r.value;
  }
  return null;
}

// Quantiles from a merged histogram delta distribution over [from,to].
// `metric` is the base name (we look at `metric + '_bucket'`). Returns
// { quantiles: {q: value}, meanMs? } — relies on `_sum`/`_count` if present.
export function histogramQuantiles(db, metric, labelsFilter, from, to, qs = [0.5, 0.95]) {
  const bucketMetric = `${metric}_bucket`;
  const series = seriesInWindowWithPrefetch(db, bucketMetric, from, to);
  const merged = new Map(); // le -> total delta count
  for (const [labelsKey, s] of series) {
    const obj = JSON.parse(labelsKey);
    if (obj.le === undefined) continue;
    if (!labelsMatch(obj, labelsFilter)) continue;
    // carry-forward per-series delta across its points
    let last = s.startValue;
    const perLe = new Map();
    for (const p of s.points) {
      const d = p.value - last;
      last = p.value;
      if (d > 0) perLe.set(obj.le, (perLe.get(obj.le) ?? 0) + d);
    }
    for (const [le, d] of perLe) merged.set(le, (merged.get(le) ?? 0) + d);
  }
  if (merged.size === 0) return { quantiles: Object.fromEntries(qs.map((q) => [q, null])), mean: null };

  const leToNum = (le) => (le === '+Inf' ? Infinity : Number(le));
  const buckets = [...merged.entries()]
    .map(([le, c]) => ({ upper: leToNum(le), cumulative: c }))
    .sort((a, b) => a.upper - b.upper);

  // merged values are cumulative deltas; the +Inf bucket equals the total count.
  const total = buckets.length ? buckets[buckets.length - 1].cumulative : 0;
  const result = {};
  for (const q of qs) {
    const target = q * total;
    let val = null;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const prevCum = i === 0 ? 0 : buckets[i - 1].cumulative;
      if (b.cumulative >= target) {
        const lower = i === 0 ? 0 : buckets[i - 1].upper;
        if (b.upper === Infinity) {
          val = lower; // percentile beyond the largest finite bucket
        } else if (b.cumulative - prevCum > 0 && b.upper !== lower) {
          val = lower + (b.upper - lower) * ((target - prevCum) / (b.cumulative - prevCum));
        } else {
          val = b.upper;
        }
        break;
      }
    }
    result[q] = val == null ? null : val;
  }
  // mean latency from _sum / _count deltas
  let mean = null;
  const sumDelta = counterDelta(db, `${metric}_sum`, labelsFilter, from, to);
  const countDelta = counterDelta(db, `${metric}_count`, labelsFilter, from, to);
  if (countDelta > 0) mean = sumDelta / countDelta;
  return { quantiles: result, mean };
}

// ---- trend (time series) ----------------------------------------------------
function bucketize(from, to, bucketSec) {
  const start = Math.floor(from / bucketSec) * bucketSec;
  const pts = [];
  for (let t = start; t <= to; t += bucketSec) pts.push(t);
  if (pts[pts.length - 1] !== to) pts.push(to);
  return pts;
}

// Counter rate per bucket (delta within each bucket). Returns [{ts, value}].
export function trendCounter(db, metric, labelsFilter, from, to, bucketSec) {
  const series = seriesInWindowWithPrefetch(db, metric, from, to);
  const bounds = bucketize(from, to, bucketSec);
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const bStart = bounds[i];
    const bEnd = bounds[i + 1];
    let delta = 0;
    for (const [labelsKey, s] of series) {
      if (!labelsMatch(JSON.parse(labelsKey), labelsFilter)) continue;
      const valEnd = latestInPoints(s.points, bEnd, s.startValue);
      const valStart = latestInPoints(s.points, bStart, s.startValue);
      const d = valEnd - valStart;
      if (d > 0) delta += d;
    }
    out.push({ ts: bStart, value: Number(delta.toFixed(3)) });
  }
  return out;
}

// Gauge value per bucket (point-in-time snapshot at bucket end).
export function trendGauge(db, metric, labelsFilter, from, to, bucketSec) {
  const series = seriesInWindowWithPrefetch(db, metric, from, to);
  const bounds = bucketize(from, to, bucketSec);
  const out = [];
  for (let i = 1; i < bounds.length; i++) {
    const bEnd = bounds[i];
    let sum = 0;
    let n = 0;
    for (const [labelsKey, s] of series) {
      if (!labelsMatch(JSON.parse(labelsKey), labelsFilter)) continue;
      const v = latestInPoints(s.points, bEnd, s.startValue);
      if (v != null) {
        sum += v;
        n++;
      }
    }
    out.push({ ts: bounds[i - 1], value: n ? Number((sum / n).toFixed(3)) : 0 });
  }
  return out;
}

// Histogram quantile per bucket. Returns [{ts, value}] for the given quantile.
export function trendHistogram(db, metric, labelsFilter, from, to, bucketSec, q = 0.95) {
  const bucketMetric = `${metric}_bucket`;
  const series = seriesInWindowWithPrefetch(db, bucketMetric, from, to);
  const bounds = bucketize(from, to, bucketSec);
  const out = [];
  for (let i = 1; i < bounds.length; i++) {
    const bStart = bounds[i - 1];
    const bEnd = bounds[i];
    const merged = new Map();
    for (const [labelsKey, s] of series) {
      const obj = JSON.parse(labelsKey);
      if (obj.le === undefined) continue;
      if (labelsFilter && !labelsMatch(obj, labelsFilter)) continue;
      let last = s.startValue;
      const perLe = new Map();
      for (const p of s.points) {
        const d = p.value - last;
        last = p.value;
        if (d > 0) perLe.set(obj.le, (perLe.get(obj.le) ?? 0) + d);
      }
      for (const [le, d] of perLe) merged.set(le, (merged.get(le) ?? 0) + d);
    }
    out.push({ ts: bStart, value: merged.size ? quantileFromBuckets(merged, q) : null });
  }
  return out;
}

function quantileFromBuckets(merged, q) {
  const leToNum = (le) => (le === '+Inf' ? Infinity : Number(le));
  const buckets = [...merged.entries()]
    .map(([le, c]) => ({ upper: leToNum(le), cumulative: c }))
    .sort((a, b) => a.upper - b.upper);
  if (!buckets.length) return null;
  // The +Inf bucket's cumulative delta equals the total request count in the window.
  const total = buckets[buckets.length - 1].cumulative;
  if (total === 0) return null;
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const prevCum = cum;
    cum = b.cumulative;
    if (cum >= target) {
      const lower = i === 0 ? 0 : buckets[i - 1].upper;
      if (b.upper === Infinity) {
        // percentile falls beyond the largest finite bucket; report that finite bound
        return i === 0 ? Infinity : buckets[i - 1].upper;
      }
      const bucketCount = cum - prevCum;
      if (bucketCount > 0 && b.upper !== lower) {
        return lower + (b.upper - lower) * ((target - prevCum) / bucketCount);
      }
      return b.upper;
    }
  }
  return buckets[buckets.length - 1].upper;
}

// latest value in points with ts <= t; fallback to startValue if none
function latestInPoints(points, t, startValue) {
  let v = null;
  for (const p of points) {
    if (p.ts <= t) v = p.value;
    else break;
  }
  return v == null ? startValue : v;
}

// ---- collector --------------------------------------------------------------
export function createMetricsCollector(cfg) {
  const dbFile = cfg.metricsDb || path.join(PROJECT_ROOT, 'data', 'metrics.db');
  const intervalSec = cfg.metricsScrapeIntervalSeconds ?? 10;
  const retentionDays = cfg.metricsRetentionDays ?? 7;
  const metricsBase = cfg.gateway?.metrics || '';

  const state = {
    enabled: !!metricsBase,
    reachable: false,
    lastScrapeAt: null,
    lastScrapeOk: false,
    lastScrapeError: null,
    seriesCount: 0,
    dbRows: 0,
    retentionDays,
    scrapeIntervalSeconds: intervalSec,
    metricsUrl: metricsBase ? `${metricsBase}/metrics` : null,
  };

  let db = null;
  let timer = null;

  function initDb() {
    db = openDb(dbFile);
  }

  async function scrape() {
    if (!db) return;
    const res = await fetchWithTimeout(state.metricsUrl, {}, METRICS_TIMEOUT_MS);
    if (!res.ok) {
      state.lastScrapeOk = false;
      state.lastScrapeError = res.error ? `HTTP ${res.status} — ${res.error}` : `HTTP ${res.status}`;
      return;
    }
    let samples;
    try {
      samples = parseExposition(res.data);
    } catch (e) {
      state.lastScrapeOk = false;
      state.lastScrapeError = `parse: ${e.message}`;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const minute = Math.floor(now / 60) * 60;
    try {
      const insert = db.prepare(
        'INSERT OR REPLACE INTO samples (metric, labels, ts, value) VALUES (?, ?, ?, ?)',
      );
      db.exec('BEGIN');
      for (const s of samples) {
        insert.run(s.metric, canonicalLabels(s.labels), minute, s.value);
      }
      // prune
      const cutoff = now - retentionDays * 86400;
      db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
      db.exec('COMMIT');
      state.reachable = true;
      state.lastScrapeOk = true;
      state.lastScrapeError = null;
      state.lastScrapeAt = now;
      state.seriesCount = db
        .prepare('SELECT COUNT(*) AS c FROM (SELECT DISTINCT metric, labels FROM samples)')
        .get().c;
      state.dbRows = db.prepare('SELECT COUNT(*) AS c FROM samples').get().c;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      state.lastScrapeOk = false;
      state.lastScrapeError = `store: ${e.message}`;
    }
  }

  function start() {
    if (!state.enabled) {
      state.lastScrapeError = 'metrics listener 未配置（gateway.metrics 为空）';
      return;
    }
    try {
      initDb();
    } catch (e) {
      state.lastScrapeError = `db: ${e.message}`;
      return;
    }
    scrape();
    timer = setInterval(scrape, Math.max(1, intervalSec) * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function getState() {
    return { ...state, metricsUrl: state.metricsUrl };
  }

  function getDb() {
    if (!db) {
      try {
        initDb();
      } catch {
        return null;
      }
    }
    return db;
  }

  return { start, getState, getDb };
}
