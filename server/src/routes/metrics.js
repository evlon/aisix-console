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
  latestGaugesByLabel,
  histogramQuantiles,
  trendCounter,
  trendGauge,
  trendHistogram,
  storeCoverage,
} from '../metrics.js';

const SPEND_DIVISOR = 1e6; // micro-USD -> USD

// Token families. input/output/total are the three the gateway has always had;
// the cache ones are incremented separately (Anthropic reports cache tokens as
// counters ON TOP of input_tokens), so they must never be summed into input.
const TOKENS_IN = 'aisix_llm_input_tokens_total';
const TOKENS_OUT = 'aisix_llm_output_tokens_total';
const TOKENS_TOTAL = 'aisix_llm_total_tokens_total';
const TOKENS_CACHED = 'aisix_llm_cached_input_tokens_total';
const TOKENS_CACHE_READ = 'aisix_llm_cache_read_input_tokens_total';
const TOKENS_CACHE_CREATION = 'aisix_llm_cache_creation_input_tokens_total';
// Dedicated low-cardinality family sliced by client_type x model x token_type.
// The three token_type rows are ALTERNATIVE views of the same tokens, so a
// query must filter to one of them or it triples the number.
const TOKENS_BY_CLIENT = 'aisix_llm_tokens_by_client_total';

// Budget/credit gauges, all point-in-time (see the summary handler).
const BUDGET_LIMIT = 'aisix_budget_limit_usd';
const BUDGET_SPENT = 'aisix_budget_spent_usd';
const BUDGET_REMAINING = 'aisix_budget_remaining_usd';
const BUDGET_RESET = 'aisix_budget_reset_seconds';
const RATELIMIT_REMAINING_TOKENS = 'aisix_ratelimit_remaining_tokens';

const TREND_DEFS = {
  requests: { metric: 'aisix_requests_total', fn: 'counter', unit: 'count', scale: 1 },
  tokens_in: { metric: TOKENS_IN, fn: 'counter', unit: 'tokens', scale: 1 },
  tokens_out: { metric: TOKENS_OUT, fn: 'counter', unit: 'tokens', scale: 1 },
  tokens: { metric: TOKENS_TOTAL, fn: 'counter', unit: 'tokens', scale: 1 },
  cache_read: { metric: TOKENS_CACHE_READ, fn: 'counter', unit: 'tokens', scale: 1 },
  cache_creation: { metric: TOKENS_CACHE_CREATION, fn: 'counter', unit: 'tokens', scale: 1 },
  spend: { metric: 'aisix_llm_spend_micro_usd_total', fn: 'counter', unit: 'usd', scale: SPEND_DIVISOR },
  latency_p50: { metric: 'aisix_request_duration_seconds', fn: 'hist', q: 0.5, unit: 'ms', scale: 1000 },
  latency_p95: { metric: 'aisix_request_duration_seconds', fn: 'hist', q: 0.95, unit: 'ms', scale: 1000 },
  in_flight: { metric: 'aisix_proxy_in_flight_requests', fn: 'gauge', unit: 'count', scale: 1 },
  ratelimit: { metric: 'aisix_ratelimit_rejections_total', fn: 'counter', unit: 'count', scale: 1 },
};

// Point-in-time budget/credit gauges, merged across the four families by the
// identity they are labelled with. A gauge family only appears after its first
// observation, so an empty list means "no budget configured", not "unsupported".
function budgetRows(db) {
  const collect = (metric) => {
    const rows = [];
    for (const r of latestGaugesByLabel(db, metric)) {
      const apiKey = r.labels.api_key_id ?? null;
      const team = r.labels.team_id ?? null;
      const user = r.labels.user_id ?? null;
      const name = r.labels.api_key_name ?? r.labels.team_name ?? r.labels.user_name ?? null;
      rows.push({ key: apiKey || team || user || '—', apiKey, team, user, name, value: r.value });
    }
    return rows;
  };
  const byKey = new Map();
  const merge = (metric, rows) => {
    for (const r of rows) {
      const cur = byKey.get(r.key) ?? { key: r.key, apiKey: r.apiKey, team: r.team, user: r.user, name: r.name };
      cur[metric] = r.value;
      byKey.set(r.key, cur);
    }
  };
  merge('limitUsd', collect(BUDGET_LIMIT));
  merge('spentUsd', collect(BUDGET_SPENT));
  merge('remainingUsd', collect(BUDGET_REMAINING));
  merge('resetSeconds', collect(BUDGET_RESET));
  return [...byKey.values()].map((r) => ({
    api_key_id: r.apiKey,
    team_id: r.team,
    user_id: r.user,
    name: r.name,
    limitUsd: r.limitUsd ?? null,
    spentUsd: r.spentUsd ?? null,
    remainingUsd: r.remainingUsd ?? null,
    resetSeconds: r.resetSeconds ?? null,
  }));
}

function avgPerRequest(tokens, requests) {
  return requests > 0 ? Number((tokens / requests).toFixed(2)) : null;
}

function coverageOf(db, from) {
  const cov = storeCoverage(db);
  return {
    earliestSampleAt: cov.from,
    latestSampleAt: cov.to,
    // True when the requested window starts before anything the store holds, so
    // the numbers are a floor. The UI must say so rather than show them bare.
    partial: cov.from == null || cov.from > from,
  };
}

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

    const inputTokens = counterDelta(db, TOKENS_IN, null, from, to);
    const outputTokens = counterDelta(db, TOKENS_OUT, null, from, to);
    const totalTokens = counterDelta(db, TOKENS_TOTAL, null, from, to);
    const spendUsd = counterDelta(db, 'aisix_llm_spend_micro_usd_total', null, from, to) / SPEND_DIVISOR;
    // Cache counters are separate from input_tokens upstream, so they are
    // reported alongside — never folded into input.
    const cachedInputTokens = counterDelta(db, TOKENS_CACHED, null, from, to);
    const cacheReadTokens = counterDelta(db, TOKENS_CACHE_READ, null, from, to);
    const cacheCreationTokens = counterDelta(db, TOKENS_CACHE_CREATION, null, from, to);

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
      cachedInputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      avgTokensPerRequest: avgPerRequest(totalTokens, requests),
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
        const filter = { model };
        const tokens = counterDelta(db, TOKENS_TOTAL, filter, from, to);
        const spend = counterDelta(db, 'aisix_llm_spend_micro_usd_total', filter, from, to) / SPEND_DIVISOR;
        const p95 = histogramQuantiles(db, 'aisix_request_duration_seconds', filter, from, to, [0.95]);
        return {
          model,
          requests: reqs,
          inputTokens: counterDelta(db, TOKENS_IN, filter, from, to),
          outputTokens: counterDelta(db, TOKENS_OUT, filter, from, to),
          tokens,
          avgTokensPerRequest: avgPerRequest(tokens, reqs),
          cacheReadTokens: counterDelta(db, TOKENS_CACHE_READ, filter, from, to),
          spendUsd: Number(spend.toFixed(4)),
          p95LatencyMs: p95.quantiles[0.95] != null ? Math.round(p95.quantiles[0.95] * 1000) : null,
        };
      });

    const byKey = counterBreakdown(db, 'aisix_llm_requests_total', 'api_key_id', from, to)
      .slice(0, 20)
      .map(({ key: api_key_id, value: reqs }) => {
        const filter = { api_key_id };
        const tokens = counterDelta(db, TOKENS_TOTAL, filter, from, to);
        const spend = counterDelta(db, 'aisix_llm_spend_micro_usd_total', filter, from, to) / SPEND_DIVISOR;
        return {
          api_key_id,
          requests: reqs,
          inputTokens: counterDelta(db, TOKENS_IN, filter, from, to),
          outputTokens: counterDelta(db, TOKENS_OUT, filter, from, to),
          tokens,
          avgTokensPerRequest: avgPerRequest(tokens, reqs),
          spendUsd: Number(spend.toFixed(4)),
        };
      });

    // Which inbound clients are spending the tokens. `token_type` is an
    // alternative view (input/output/total describe the same tokens), so each
    // breakdown filters to exactly one — otherwise the numbers triple.
    const clientBy = (tokenType) =>
      new Map(
        counterBreakdown(db, TOKENS_BY_CLIENT, 'client_type', from, to, { token_type: tokenType }).map((r) => [
          r.key,
          r.value,
        ]),
      );
    const clientTotal = clientBy('total');
    const clientIn = clientBy('input');
    const clientOut = clientBy('output');
    const byClient = [...clientTotal.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([client_type, tokens]) => ({
        client_type,
        tokens,
        inputTokens: clientIn.get(client_type) ?? 0,
        outputTokens: clientOut.get(client_type) ?? 0,
      }));

    res.json({
      range: req.query.range || '1h',
      window: { from, to },
      coverage: coverageOf(db, from),
      totals,
      byModel,
      byKey,
      byClient,
      budgets: budgetRows(db),
      ratelimitRemainingTokens: latestGaugesByLabel(db, RATELIMIT_REMAINING_TOKENS).map((r) => ({
        api_key_id: r.labels.api_key_id ?? null,
        model: r.labels.model ?? null,
        remaining: r.value,
      })),
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

    res.json({ range: req.query.range || '1h', window: { from, to }, bucketSec, coverage: coverageOf(db, from), series });
  });

  return router;
}
