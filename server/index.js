// Express app assembly + server entry.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import * as secrets from './src/secrets.js';
import { createSaver } from './src/savePipeline.js';
import { makeGatewayClient } from './src/gateway.js';
import { resourcesRouter } from './src/routes/resources.js';
import { statusRouter, secretsRouter, miscRouter } from './src/routes/status.js';
import { playgroundRouter } from './src/routes/playground.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildApp(cfg) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Optional bearer token guarding the console itself (loopback-only by default).
  if (cfg.consoleToken) {
    app.use((req, res, next) => {
      const auth = req.headers.authorization || '';
      if (auth === `Bearer ${cfg.consoleToken}`) return next();
      res.status(401).json({ error: '未授权' });
    });
  }

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
  console.log(`  reloadCommand : ${cfg.reloadCommand || '(未配置 — 保存后需手动重载网关)'}`);
});
