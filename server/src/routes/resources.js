// Resource CRUD routes. Reads serve the live file; writes go through the
// save pipeline (validate gate). Returns save results so the UI can render
// per-entry errors.
import { Router } from 'express';
import {
  loadFile,
  normalizeDoc,
  isResourceDoc,
  bootstrapTemplate,
  serialize,
  IDENTITY_FIELD,
  findIndex,
  identityOf,
  fingerprint,
} from '../resources.js';
import * as secrets from '../secrets.js';

export function resourcesRouter(ctx) {
  const router = Router();
  const { saver } = ctx;

  const currentDoc = () => {
    const r = loadFile(ctx.cfg.resourcesFile);
    if (!r.ok) return { error: r };
    if (!isResourceDoc(r.doc)) {
      return { error: { ok: false, text: r.text, error: '文件不是有效的 resources.yaml 文档（缺少资源集合）' } };
    }
    return { doc: normalizeDoc(r.doc) };
  };

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

  // Full-document save (raw YAML editor / bootstrap). Body: {text} or {doc}.
  router.put('/raw', async (req, res) => {
    let doc;
    if (req.body?.doc) {
      if (!isResourceDoc(req.body.doc)) {
        return res.status(409).json({ ok: false, errors: [{ scope: '(file)', message: '文档缺少资源集合' }] });
      }
      doc = normalizeDoc(req.body.doc);
    } else if (typeof req.body?.text === 'string') {
      const r = loadFile(ctx.cfg.resourcesFile);
      if (r.ok) {
        // Preserve the current in-memory doc unless the text parses; the raw
        // editor is meant for repairs, so if it parses we take it.
        try {
          const { parse } = await import('yaml');
          const parsed = parse(req.body.text, { uniqueKeys: true });
          if (!isResourceDoc(parsed)) {
            return res.status(409).json({ ok: false, errors: [{ scope: '(file)', message: '文本不是有效的 resources.yaml（缺少资源集合）' }] });
          }
          doc = normalizeDoc(parsed);
        } catch (e) {
          return res.status(409).json({ ok: false, errors: [{ scope: '(file)', message: `YAML 解析失败: ${e.message}` }] });
        }
      }
    }
    if (!doc) {
      return res.status(400).json({ ok: false, errors: [{ scope: '(file)', message: '请求体需包含 doc 或 text' }] });
    }
    const result = await saver.save(doc);
    res.status(result.ok ? 200 : 409).json(result);
  });

  router.post('/bootstrap', async (req, res) => {
    const result = await saver.save(bootstrapTemplate());
    res.status(result.ok ? 200 : 409).json(result);
  });

  // GET/POST /api/resources/:kind ; GET/PUT/DELETE /api/resources/:kind/:identity
  router.get('/:kind', (req, res) => {
    const { kind } = req.params;
    if (!(kind in IDENTITY_FIELD)) {
      return res.status(404).json({ error: `未知资源类型: ${kind}` });
    }
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);
    res.json({ entries: doc[kind] ?? [], fingerprint: fingerprint(ctx.cfg.resourcesFile) });
  });

  router.post('/:kind', async (req, res) => {
    const { kind } = req.params;
    if (!(kind in IDENTITY_FIELD)) {
      return res.status(404).json({ error: `未知资源类型: ${kind}` });
    }
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);

    const entry = req.body?.entry ?? req.body;
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: '请求体需包含资源对象' }] });
    }
    const identity = identityOf(kind, entry);
    if (!identity) {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: `缺少标识字段 ${IDENTITY_FIELD[kind]}` }] });
    }
    const arr = doc[kind];
    const idx = findIndex(arr, kind, identity);
    if (idx >= 0) {
      return res.status(409).json({ errors: [{ scope: `${kind}[${idx}] ("${identity}")`, message: `${IDENTITY_FIELD[kind]} 已存在，请使用更新操作` }] });
    }
    arr.push(entry);
    const result = await saver.save(doc);
    res.status(result.ok ? 200 : 409).json(result);
  });

  router.get('/:kind/:identity', (req, res) => {
    const { kind, identity } = req.params;
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);
    const idx = findIndex(doc[kind], kind, identity);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    res.json({ entry: doc[kind][idx] });
  });

  router.put('/:kind/:identity', async (req, res) => {
    const { kind, identity } = req.params;
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);

    const entry = req.body?.entry ?? req.body;
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: '请求体需包含资源对象' }] });
    }
    const newIdentity = identityOf(kind, entry);
    if (!newIdentity) {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: `缺少标识字段 ${IDENTITY_FIELD[kind]}` }] });
    }
    const arr = doc[kind];
    const idx = findIndex(arr, kind, identity);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    const dupIdx = findIndex(arr, kind, newIdentity);
    if (dupIdx >= 0 && dupIdx !== idx) {
      return res.status(409).json({ errors: [{ scope: `${kind}[${dupIdx}] ("${newIdentity}")`, message: `${IDENTITY_FIELD[kind]} 与另一条目冲突` }] });
    }
    arr[idx] = entry;
    const result = await saver.save(doc);
    res.status(result.ok ? 200 : 409).json(result);
  });

  router.delete('/:kind/:identity', async (req, res) => {
    const { kind, identity } = req.params;
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);
    const idx = findIndex(doc[kind], kind, identity);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    doc[kind].splice(idx, 1);
    const result = await saver.save(doc);
    res.status(result.ok ? 200 : 409).json(result);
  });

  return router;
}
