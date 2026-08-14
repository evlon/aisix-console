// Metrics API: scrape/collector status, interval usage summary, and trend
// series. All routes sit under /api/metrics and are protected by the global
// /api auth guard. Usage data is computed from the SQLite snapshot store kept
// by the collector in metrics.js.
import { Router } from 'express';
import {
  parseRange,
  bucketSizeForRange,
  counterDelta,
  counterBreakdown,
  latestGauge,
  histogramQuantiles,
  trendCounter,
  trendGauge,
  trendHistogram,
} from '../metrics.js';

const SPEND_DIVISOR = 1e6; // micro-USD -> USD

const TREND_DEFS = {
  requests: { metric: 'aisix_requests_total', fn: 'counter', unit: 'count', scale: 1 },
  tokens_in: { metric: 'aisix_llm_input_tokens_total', fn: 'counter', unit: 'tokens', scale: 1 },
  tokens_out: { metric: 'aisix_llm_output_tokens_total', fn: 'counter', unit: 'tokens', scale: 1 },
  tokens: { metric: 'aisix_llm_total_tokens_total', fn: 'counter', unit: 'tokens', scale: 1 },
  spend: { metric: 'aisix_llm_spend_micro_usd_total', fn: 'counter', unit: 'usd', scale: SPEND_DIVISOR },
  latency_p50: { metric: 'aisix_request_duration_seconds', fn: 'hist', q: 0.5, unit: 'ms', scale: 1000 },
  latency_p95: { metric: 'aisix_request_duration_seconds', fn: 'hist', q: 0.95, unit: 'ms', scale: 1000 },
  in_flight: { metric: 'aisix_proxy_in_flight_requests', fn: 'gauge', unit: 'count', scale: 1 },
  ratelimit: { metric: 'aisix_ratelimit_rejections_total', fn: 'counter', unit: 'count', scale: 1 },
};

export function metricsRouter(ctx) {
  const router = Router();
  const { metrics } = ctx;

  router.get('/overview', (_req, res) => {
    res.json(metrics.getState());
  });

  router.get('/summary', (req, res) => {
    const db = metrics.getDb();
    if (!db) return res.status(503).json({ error: 'metrics store 未就绪', state: metrics.getState() });
    const seconds = parseRange(req.query.range);
    const to = Math.floor(Date.now() / 1000);
    const from = to - seconds;

    const requests = counterDelta(db, 'aisix_requests_total', null, from, to);
    const success = counterDelta(db, 'aisix_requests_total', { outcome: 'success' }, from, to);
    const failures = Math.max(0, requests - success);

    const inputTokens = counterDelta(db, 'aisix_llm_input_tokens_total', null, from, to);
    const outputTokens = counterDelta(db, 'aisix_llm_output_tokens_total', null, from, to);
    const totalTokens = counterDelta(db, 'aisix_llm_total_tokens_total', null, from, to);
    const spendUsd = counterDelta(db, 'aisix_llm_spend_micro_usd_total', null, from, to) / SPEND_DIVISOR;

    const dur = histogramQuantiles(db, 'aisix_request_duration_seconds', null, from, to, [0.5, 0.95]);
    const ttft = histogramQuantiles(db, 'aisix_request_ttft_seconds', null, from, to, [0.5, 0.95]);

    const totals = {
      requests,
      success,
      failures,
      successRate: requests > 0 ? Number(((success / requests) * 100).toFixed(2)) : null,
      inputTokens,
      outputTokens,
      totalTokens,
      spendUsd: Number(spendUsd.toFixed(4)),
      avgLatencyMs: dur.mean != null ? Math.round(dur.mean * 1000) : null,
      p95LatencyMs: dur.quantiles[0.95] != null ? Math.round(dur.quantiles[0.95] * 1000) : null,
      ttftMs: ttft.mean != null ? Math.round(ttft.mean * 1000) : null,
      inFlight: latestGauge(db, 'aisix_proxy_in_flight_requests', null),
      ratelimitRejections: counterDelta(db, 'aisix_ratelimit_rejections_total', null, from, to),
    };

    const byModel = counterBreakdown(db, 'aisix_requests_total', 'model', from, to)
      .slice(0, 20)
      .map(({ key: model, value: reqs }) => {
        const tokens = counterDelta(db, 'aisix_llm_total_tokens_total', { model }, from, to);
        const spend = counterDelta(db, 'aisix_llm_spend_micro_usd_total', { model }, from, to) / SPEND_DIVISOR;
        const p95 = histogramQuantiles(db, 'aisix_request_duration_seconds', { model }, from, to, [0.95]);
        return {
          model,
          requests: reqs,
          tokens,
          spendUsd: Number(spend.toFixed(4)),
          p95LatencyMs: p95.quantiles[0.95] != null ? Math.round(p95.quantiles[0.95] * 1000) : null,
        };
      });

    const byKey = counterBreakdown(db, 'aisix_llm_requests_total', 'api_key_id', from, to)
      .slice(0, 20)
      .map(({ key: api_key_id, value: reqs }) => {
        const tokens = counterDelta(db, 'aisix_llm_total_tokens_total', { api_key_id }, from, to);
        const spend = counterDelta(db, 'aisix_llm_spend_micro_usd_total', { api_key_id }, from, to) / SPEND_DIVISOR;
        return { api_key_id, requests: reqs, tokens, spendUsd: Number(spend.toFixed(4)) };
      });

    res.json({
      range: req.query.range || '1h',
      window: { from, to },
      totals,
      byModel,
      byKey,
    });
  });

  router.get('/trend', (req, res) => {
    const db = metrics.getDb();
    if (!db) return res.status(503).json({ error: 'metrics store 未就绪', state: metrics.getState() });
    const seconds = parseRange(req.query.range);
    const to = Math.floor(Date.now() / 1000);
    const from = to - seconds;
    const bucketSec = bucketSizeForRange(seconds);

    const names = (req.query.series || 'requests')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => TREND_DEFS[s])
      .slice(0, 8);
    if (names.length === 0) names.push('requests');

    const series = names.map((name) => {
      const def = TREND_DEFS[name];
      let points;
      if (def.fn === 'counter') {
        points = trendCounter(db, def.metric, null, from, to, bucketSec);
      } else if (def.fn === 'gauge') {
        points = trendGauge(db, def.metric, null, from, to, bucketSec);
      } else {
        points = trendHistogram(db, def.metric, null, from, to, bucketSec, def.q);
      }
      if (def.scale !== 1) {
        points = points.map((p) => ({ ts: p.ts, value: p.value == null ? null : Number((p.value * def.scale).toFixed(3)) }));
      }
      return { name, unit: def.unit, points };
    });

    res.json({ range: req.query.range || '1h', window: { from, to }, bucketSec, series });
  });

  return router;
}
