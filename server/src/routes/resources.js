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
  identityFieldOf,
  findIndex,
  identityOf,
  fingerprint,
  deriveId,
  formatVersionOf,
  migrateToV2,
  externalizeRefs,
  internalizeRefs,
  unresolvedReference,
  FORMAT_VERSION_V2,
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

  // Turn a view-shaped entry into the wire shape the file's format version
  // needs, and reject a named reference that does not exist. On a v2 file there
  // is no name sugar to fall back on, so an unresolved name would otherwise
  // surface only as a bare "unknown field" from the schema.
  const prepareEntry = (kind, doc, raw) => {
    const version = formatVersionOf(doc);
    const bad = unresolvedReference(kind, raw, doc, version);
    if (bad) return { error: bad };
    return { entry: internalizeRefs(kind, raw, doc, version) };
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
  // File-format metadata. Must be registered before `/:kind`, or Express would
  // treat "meta" as a resource kind.
  router.get('/meta', (_req, res) => {
    const r = loadFile(ctx.cfg.resourcesFile);
    if (!r.ok) return res.json({ ok: false, exists: r.exists, error: r.error || null });
    res.json({
      ok: true,
      exists: true,
      formatVersion: formatVersionOf(r.doc),
      fingerprint: fingerprint(ctx.cfg.resourcesFile),
      eligible: true,
    });
  });

  // Migrate the file from format v1 to v2 (the format aisix >= 1.11 requires).
  //
  // Self-guarding: the save runs `aisix validate` with the configured binary,
  // so a gateway older than 1.11 rejects the migrated document ("unrecognized
  // _format_version \"2\"") and NOTHING is written. The action cannot push a
  // file the gateway in front of it cannot read.
  router.post('/migrate-format-v2', async (_req, res) => {
    const cur = currentDoc();
    if (cur.error) return res.status(409).json(cur.error);
    if (formatVersionOf(cur.doc) === FORMAT_VERSION_V2) {
      return res.json({ ok: true, alreadyV2: true });
    }
    const result = await saver.save(migrateToV2(cur.doc));
    res.status(result.ok ? 200 : 409).json({
      ...result,
      migrated: result.ok,
      // A mismatch here means the gateway binary is older than 1.11.
      hint: result.ok
        ? null
        : '迁移被 aisix validate 拒绝。若错误是 unrecognized _format_version "2"，说明当前网关二进制早于 1.11，请先升级网关。',
    });
  });

  router.get('/:kind', (req, res) => {
    const { kind } = req.params;
    if (!(kind in IDENTITY_FIELD)) {
      return res.status(404).json({ error: `未知资源类型: ${kind}` });
    }
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);
    res.json({
      // Present id references under their v1 name so a v2 file does not turn
      // the provider-key picker into a uuid box.
      entries: (doc[kind] ?? []).map((e) => externalizeRefs(kind, e, doc)),
      formatVersion: formatVersionOf(doc),
      fingerprint: fingerprint(ctx.cfg.resourcesFile),
    });
  });

  // Derived-id map for a kind: [{identity, id}] where id = uuid5("<kind>/<identity>").
  // Needed by the UI only where upstream has no name sugar for a reference
  // (mcp_auth_settings.anonymous.api_key_id) — lets operators pick a name and
  // have the console write the canonical UUID the gateway actually expects.
  router.get('/:kind/derived-ids', (req, res) => {
    const { kind } = req.params;
    if (!(kind in IDENTITY_FIELD)) {
      return res.status(404).json({ error: `未知资源类型: ${kind}` });
    }
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);
    const entries = doc[kind] ?? [];
    const rows = [];
    for (const entry of entries) {
      const identity = identityOf(kind, entry);
      if (!identity) continue;
      rows.push({ identity, id: deriveId(kind, identity) });
    }
    res.json({ rows });
  });

  router.post('/:kind', async (req, res) => {
    const { kind } = req.params;
    if (!(kind in IDENTITY_FIELD)) {
      return res.status(404).json({ error: `未知资源类型: ${kind}` });
    }
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);

    const raw = req.body?.entry ?? req.body;
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: '请求体需包含资源对象' }] });
    }
    const prepared = prepareEntry(kind, doc, raw);
    if (prepared.error) {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: prepared.error }] });
    }
    const entry = prepared.entry;
    const identity = identityOf(kind, entry);
    if (!identity) {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: `缺少标识字段 ${identityFieldOf(kind) || 'identity'}` }] });
    }
    const arr = doc[kind];
    const idx = findIndex(arr, kind, identity);
    if (idx >= 0) {
      return res.status(409).json({ errors: [{ scope: `${kind}[${idx}] ("${identity}")`, message: `${identityFieldOf(kind) || 'identity'} 已存在，请使用更新操作` }] });
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
    res.json({ entry: externalizeRefs(kind, doc[kind][idx], doc) });
  });

  router.put('/:kind/:identity', async (req, res) => {
    const { kind, identity } = req.params;
    const { doc, error } = currentDoc();
    if (error) return res.status(409).json(error);

    const raw = req.body?.entry ?? req.body;
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: '请求体需包含资源对象' }] });
    }
    const prepared = prepareEntry(kind, doc, raw);
    if (prepared.error) {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: prepared.error }] });
    }
    const entry = prepared.entry;
    const newIdentity = identityOf(kind, entry);
    if (!newIdentity) {
      return res.status(400).json({ errors: [{ scope: `(${kind})`, message: `缺少标识字段 ${identityFieldOf(kind) || 'identity'}` }] });
    }
    const arr = doc[kind];
    const idx = findIndex(arr, kind, identity);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    const dupIdx = findIndex(arr, kind, newIdentity);
    if (dupIdx >= 0 && dupIdx !== idx) {
      return res.status(409).json({ errors: [{ scope: `${kind}[${dupIdx}] ("${newIdentity}")`, message: `${identityFieldOf(kind) || 'identity'} 与另一条目冲突` }] });
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
