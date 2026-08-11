// Backend config: loads aisix-console.yaml + env overrides.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  port: 8787,
  bind: '127.0.0.1',
  resourcesFile: path.join(PROJECT_ROOT, 'resources.yaml'),
  aisixBin: '',
  secretsFile: path.join(PROJECT_ROOT, 'secrets.env'),
  authFile: path.join(PROJECT_ROOT, 'auth.json'),
  playgroundTimeoutMs: 180000,
  gateway: {
    proxy: 'http://127.0.0.1:3000',
    admin: 'http://127.0.0.1:3001',
    metrics: 'http://127.0.0.1:9090',
    adminKey: '',
  },
  reloadCommand: '',
};

function deepMerge(base, override) {
  if (override == null || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  const configPath =
    process.env.AISIX_CONSOLE_CONFIG || path.join(PROJECT_ROOT, 'aisix-console.yaml');
  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8');
    fileCfg = parseYaml(text) || {};
  }

  const cfg = deepMerge(DEFAULTS, fileCfg);

  // Env overrides
  if (process.env.AISIX_CONSOLE_PORT) cfg.port = Number(process.env.AISIX_CONSOLE_PORT);
  if (process.env.AISIX_CONSOLE_BIND) cfg.bind = process.env.AISIX_CONSOLE_BIND;
  if (process.env.AISIX_CONSOLE_RESOURCES_FILE) {
    cfg.resourcesFile = process.env.AISIX_CONSOLE_RESOURCES_FILE;
  }
  if (process.env.AISIX_CONSOLE_AISIX_BIN) cfg.aisixBin = process.env.AISIX_CONSOLE_AISIX_BIN;
  if (process.env.AISIX_CONSOLE_RELOAD_COMMAND) {
    cfg.reloadCommand = process.env.AISIX_CONSOLE_RELOAD_COMMAND;
  }
  if (process.env.AISIX_CONSOLE_AUTH_FILE) cfg.authFile = process.env.AISIX_CONSOLE_AUTH_FILE;
  if (process.env.AISIX_CONSOLE_PLAYGROUND_TIMEOUT_MS) {
    cfg.playgroundTimeoutMs = Number(process.env.AISIX_CONSOLE_PLAYGROUND_TIMEOUT_MS);
  }

  // Resolve relative paths against the config file's directory (or project root).
  const baseDir = fs.existsSync(configPath) ? path.dirname(configPath) : PROJECT_ROOT;
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));
  cfg.resourcesFile = resolve(cfg.resourcesFile);
  cfg.aisixBin = cfg.aisixBin ? resolve(cfg.aisixBin) : '';
  cfg.secretsFile = resolve(cfg.secretsFile);
  cfg.authFile = resolve(cfg.authFile);
  cfg.configPath = configPath;

  return Object.freeze(cfg);
}
