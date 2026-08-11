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

  return router;
}
