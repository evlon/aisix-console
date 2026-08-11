// The single save chokepoint: serialize -> temp file -> aisix validate ->
// atomic replace -> reload. Serializes concurrent saves via a promise chain.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { serialize, fingerprint } from './resources.js';
import { runValidate, parseErrors } from './validate.js';
import * as secrets from './secrets.js';

let queue = Promise.resolve();

function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function atomicWrite(target, text) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target);
}

function runReload(command) {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ executed: false, warning: '文件已保存——请手动重启/重载网关生效' });
      return;
    }
    exec(command, { shell: true }, (error, _stdout, stderr) => {
      if (error) {
        resolve({
          executed: true,
          warning: `重载命令执行失败（配置已保存）: ${error.message}${stderr ? ` — ${stderr.trim()}` : ''}`,
        });
      } else {
        resolve({ executed: true });
      }
    });
  });
}

// Options: {resourcesFile, aisixBin, reloadCommand}
export function createSaver(opts) {
  async function save(doc) {
    const text = serialize(doc);
    if (!opts.aisixBin) {
      return {
        ok: false,
        errors: [{ scope: '(file)', message: 'aisixBin 未配置，无法校验 resources.yaml' }],
      };
    }
    const dir = path.dirname(opts.resourcesFile);
    const tmp = path.join(dir, `.${path.basename(opts.resourcesFile)}.${process.pid}.${Date.now()}.validate`);
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      const result = await runValidate(opts.aisixBin, tmp, secrets.envForValidate());
      if (result.code !== 0) {
        return {
          ok: false,
          errors: result.message
            ? [{ scope: '(file)', message: result.message }]
            : parseErrors(result.stderr),
        };
      }
      atomicWrite(opts.resourcesFile, text);
      const loaded = /loaded (\d+) resource/i.exec(result.stdout || '');
      const reload = await runReload(opts.reloadCommand);
      return {
        ok: true,
        loaded: loaded ? Number(loaded[1]) : null,
        fingerprint: fingerprint(opts.resourcesFile),
        reload,
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    save: (doc) => enqueue(() => save(doc)),
  };
}
