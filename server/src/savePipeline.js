// The single save chokepoint: serialize -> temp file -> aisix validate ->
// atomic replace -> reload. Serializes concurrent saves via a promise chain.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { serialize, fingerprint, loadFile, reconcileIds } from './resources.js';
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
    // Keep each row's resource id across the edit.
    //
    // Every per-kind form rebuilds its entry field by field, so `id` does not
    // survive the round-trip. On a format-v2 file that would re-key the
    // resource on the next save (deriving a fresh uuid), and a rename would
    // silently orphan everything keyed by the old id — budget rows, metric
    // series, access-log history. Reconciling against the file we are about to
    // replace is the one place all writers pass through. A missing or
    // unreadable previous file simply means there is nothing to carry over.
    let candidate = doc;
    // The writer serializes the parsed document, so comments cannot survive the
    // round trip. That is a property of the console owning the file, not a fault —
    // but it must not be silent: the operator annotated this file and the next
    // save removes the annotations.
    let commentsDropped = false;
    try {
      const prev = loadFile(opts.resourcesFile);
      if (prev.ok) candidate = reconcileIds(prev.doc, doc);
      commentsDropped = /(^|\n)[ \t]*#/.test(prev.text || '');
    } catch {
      /* fall through with the doc as given */
    }
    const text = serialize(candidate);
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
        commentsDropped,
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
