// Express app assembly + server entry.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import * as secrets from './src/secrets.js';
import { initAuth } from './src/auth.js';
import { createSaver } from './src/savePipeline.js';
import { makeGatewayClient } from './src/gateway.js';
import { resourcesRouter } from './src/routes/resources.js';
import { statusRouter, secretsRouter, miscRouter } from './src/routes/status.js';
import { playgroundRouter } from './src/routes/playground.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildApp(cfg) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const auth = initAuth(cfg);

  // Public auth endpoints (everything else under /api requires login).
  app.post('/api/auth/login', auth.loginHandler);
  app.post('/api/auth/logout', auth.logoutHandler);
  app.get('/api/auth/status', auth.statusHandler);
  app.post('/api/auth/change-password', auth.requireAuth, auth.changePasswordHandler);

  // Guard the rest of the API.
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    auth.requireAuth(req, res, next);
  });

  secrets.init(cfg.secretsFile);
  const saver = createSaver({
    resourcesFile: cfg.resourcesFile,
    aisixBin: cfg.aisixBin,
    reloadCommand: cfg.reloadCommand,
  });
  const gw = makeGatewayClient(cfg);
  const ctx = { cfg, saver, gw };

  app.use('/api/status', statusRouter(ctx));
  app.use('/api/resources', resourcesRouter(ctx));
  app.use('/api/secrets', secretsRouter(ctx));
  app.use('/api/playground', playgroundRouter(ctx));
  app.use('/api', miscRouter(ctx));

  // Serve the built SPA (web/dist) in production; dev uses the Vite proxy.
  const distDir = path.resolve(__dirname, '..', 'web', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) =>
      res.send('AISIX Console 后端已启动。开发模式请运行 `npm run dev`（Vite 提供前端）。'),
    );
  }

  return app;
}

const cfg = loadConfig();
const app = buildApp(cfg);

app.listen(cfg.port, cfg.bind, () => {
  console.log(`AISIX Console listening on http://${cfg.bind}:${cfg.port}`);
  console.log(`  resourcesFile : ${cfg.resourcesFile}`);
  console.log(`  aisixBin      : ${cfg.aisixBin || '(未配置)'}`);
  console.log(`  authFile      : ${cfg.authFile}`);
  console.log(`  reloadCommand : ${cfg.reloadCommand || '(未配置 — 保存后需手动重载网关)'}`);
});
