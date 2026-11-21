// Observability-exporter helpers for the console UI.
//
// Two things the exporter page needs and could not previously get:
//
// 1. /credential-plan — turns a `credential_ref` into the exact environment
//    variables the GATEWAY must have, whether they are currently present, and
//    paste-ready injection snippets. Without this the `credential_ref` field is
//    unusable: the naming convention lives only in the gateway's sink code.
//
// 2. /health — whether telemetry is actually leaving the gateway. The exporter
//    page used to be write-only: it could configure an endpoint and never say
//    whether anything was delivered.
//
// Delivery health has an important scoping limit on the shipped gateway: the
// only available counter is `aisix_usage_event_drops_total`, which is
// gateway-wide (no `exporter` label). Per-exporter attribution
// (`aisix_otlp_fanout_drops_total{exporter,reason}` / `..._failures_total`)
// exists only in newer aisix builds, so it is feature-detected rather than
// assumed. Reporting a per-exporter number that the gateway cannot produce
// would be worse than reporting none.
import { Router } from 'express';
import { credentialPlan } from '../exporterCreds.js';
import { parseRange, counterDelta, counterBreakdown } from '../metrics.js';

const KINDS = new Set(['otlp_http', 'aliyun_sls', 'object_store', 'datadog']);
const PROVIDERS = new Set(['s3', 'gcs', 'azure_blob']);

// Metrics a newer gateway may expose for per-exporter attribution.
const PER_EXPORTER_METRICS = {
  drops: 'aisix_otlp_fanout_drops_total',
  failures: 'aisix_otlp_fanout_failures_total',
};

function pick(value, allowed) {
  const v = String(value ?? '').trim();
  return allowed.has(v) ? v : '';
}

function hasAnySeries(db, metric) {
  try {
    const row = db.prepare('SELECT 1 AS x FROM samples WHERE metric = ? LIMIT 1').get(metric);
    return !!row;
  } catch {
    return false;
  }
}

export function exportersRouter(ctx) {
  const router = Router();
  const { metrics } = ctx;

  // Derive the gateway-side environment variables for one exporter draft.
  // Read-only and side-effect free; secrets are never returned (names only).
  router.get('/credential-plan', (req, res) => {
    const kind = pick(req.query.kind, KINDS);
    if (!kind) {
      return res.status(400).json({ error: 'kind 必须是 otlp_http / aliyun_sls / object_store / datadog' });
    }
    const provider = pick(req.query.provider, PROVIDERS);
    const authMode = req.query.authMode === 'cloud_identity' ? 'cloud_identity' : 'credential_ref';
    res.json(
      credentialPlan({
        kind,
        ref: req.query.ref ?? '',
        provider,
        authMode,
      }),
    );
  });

  // Delivery health for the whole telemetry fan-out.
  router.get('/health', (req, res) => {
    const range = req.query.range || '1h';
    const db = metrics.getDb();
    if (!db) {
      return res.json({
        range,
        storeReady: false,
        gatewayReachable: metrics.getState().reachable,
        state: metrics.getState(),
      });
    }
    const seconds = parseRange(range);
    const to = Math.floor(Date.now() / 1000);
    const from = to - seconds;

    const emitted = counterDelta(db, 'aisix_usage_events_emitted_total', null, from, to);
    const drops = counterDelta(db, 'aisix_usage_event_drops_total', null, from, to);
    const dropsByReason = counterBreakdown(db, 'aisix_usage_event_drops_total', 'reason', from, to);

    // Feature-detect per-exporter attribution: present only on newer gateways.
    let perExporter = null;
    const supportsDrops = hasAnySeries(db, PER_EXPORTER_METRICS.drops);
    const supportsFailures = hasAnySeries(db, PER_EXPORTER_METRICS.failures);
    if (supportsDrops || supportsFailures) {
      const dropRows = supportsDrops
        ? counterBreakdown(db, PER_EXPORTER_METRICS.drops, 'exporter', from, to)
        : [];
      const failureRows = supportsFailures
        ? counterBreakdown(db, PER_EXPORTER_METRICS.failures, 'exporter', from, to)
        : [];
      const byName = new Map();
      for (const r of dropRows) byName.set(r.key, { exporter: r.key, drops: r.value, failures: 0 });
      for (const r of failureRows) {
        const cur = byName.get(r.key) ?? { exporter: r.key, drops: 0, failures: 0 };
        cur.failures = r.value;
        byName.set(r.key, cur);
      }
      perExporter = [...byName.values()].sort((a, b) => b.drops + b.failures - (a.drops + a.failures));
    }

    res.json({
      range,
      storeReady: true,
      gatewayReachable: metrics.getState().reachable,
      window: { from, to },
      // Gateway-wide, because the shipped gateway has no exporter dimension here.
      emitted,
      drops,
      dropRate: emitted + drops > 0 ? Number(((drops / (emitted + drops)) * 100).toFixed(2)) : null,
      dropsByReason,
      // null => the running gateway version does not expose per-exporter
      // counters; the UI must say so instead of implying every exporter is fine.
      perExporter,
      perExporterSupported: perExporter !== null,
      lastScrapeAt: metrics.getState().lastScrapeAt,
      lastScrapeOk: metrics.getState().lastScrapeOk,
    });
  });

  return router;
}
