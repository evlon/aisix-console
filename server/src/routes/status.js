// Gateway status proxy — aggregates config/models/health, tolerant of a down
// gateway. Also secrets names (never values) and misc endpoints.
import { Router } from 'express';
import * as secrets from '../secrets.js';
import { loadFile, fingerprint, KINDS } from '../resources.js';

export function statusRouter(ctx) {
  const router = Router();
  const { gw } = ctx;

  router.get('/', async (_req, res) => {
    const [config, models, health] = await Promise.all([
      gw.statusConfig(),
      gw.statusModels(),
      gw.adminHealth(),
    ]);
    // Resource counts from the file (cheap, no gateway needed).
    const r = loadFile(ctx.cfg.resourcesFile);
    const counts = {};
    if (r.ok) for (const kind of KINDS) counts[kind] = (r.doc[kind] ?? []).length;
    res.json({
      gatewayReachable: config.reachable,
      config,
      models,
      health,
      file: {
        exists: r.exists,
        ok: r.ok,
        error: r.error || null,
        fingerprint: fingerprint(ctx.cfg.resourcesFile),
        counts,
      },
    });
  });

  router.get('/config', async (_req, res) => {
    const r = await gw.statusConfig();
    res.json(r);
  });

  router.get('/models', async (_req, res) => {
    const r = await gw.statusModels();
    res.json(r);
  });

  return router;
}

export function secretsRouter(_ctx) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ vars: secrets.listNames().map((name) => ({ name, set: true })) });
  });

  router.post('/', (req, res) => {
    const { name, value } = req.body ?? {};
    if (name && value !== undefined) {
      secrets.set(name, String(value));
      res.json({ name });
    } else {
      res.status(400).json({ error: '需要 name 和 value' });
    }
  });

  router.delete('/:name', (req, res) => {
    const removed = secrets.remove(req.params.name);
    res.json({ removed });
  });

  return router;
}

export function miscRouter(ctx) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      resourcesFile: ctx.cfg.resourcesFile,
      aisixBin: ctx.cfg.aisixBin || null,
      reloadCommand: ctx.cfg.reloadCommand || null,
      gateway: ctx.cfg.gateway,
    });
  });

  // Full-file raw YAML, for the raw editor page.
  router.get('/raw', (_req, res) => {
    const r = loadFile(ctx.cfg.resourcesFile);
    res.json({
      ok: r.ok,
      exists: r.exists,
      text: r.text,
      error: r.error || null,
      fingerprint: fingerprint(ctx.cfg.resourcesFile),
    });
  });

  // List a provider key's upstream models via GET {api_base}/models, so the
  // UI can offer the real model ids instead of free text. Provider keys are
  // resolved by display_name; the fetch uses the stored api_key (never
  // returned to the client).
  router.get('/provider-models/:name', async (req, res) => {
    const r = loadFile(ctx.cfg.resourcesFile);
    if (!r.ok) {
      return res.status(400).json({ ok: false, error: r.error || 'resources.yaml 解析失败' });
    }
    const prov = (r.doc.provider_keys ?? []).find((p) => p.display_name === req.params.name);
    if (!prov) return res.status(404).json({ ok: false, error: 'provider 不存在' });
    const base = String(prov.api_base || '').replace(/\/+$/, '');
    if (!base) return res.json({ ok: false, error: 'provider 未配置 api_base' });
    const url = `${base}/models`;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const headers = {};
      if (prov.api_key) headers.Authorization = `Bearer ${prov.api_key}`;
      const upstream = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(to);
      if (!upstream.ok) return res.json({ ok: false, error: `上游 HTTP ${upstream.status}` });
      const data = await upstream.json();
      const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
      return res.json({ ok: true, models });
    } catch (e) {
      return res.json({ ok: false, error: e.name === 'AbortError' ? '上游超时' : e.message });
    }
  });

  return router;
}
