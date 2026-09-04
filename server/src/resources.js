// File-mode resources.yaml document model. The console's internal
// representation IS the file-mode (sugar) shape, so round-trips are lossless
// with respect to sugar. Never write canonical-only fields (id, etc.).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Canonical collection order emitted by the file loader.
export const KINDS = [
  'provider_keys',
  'models',
  'api_keys',
  'guardrails',
  'mcp_servers',
  'a2a_agents',
  'cache_policies',
  'observability_exporters',
  'rate_limit_policies',
  'oidc_providers',
  'claim_mappings',
];

// Identity field name per kind (used for list/get/upsert/remove and
// duplicate detection). provider_keys/models/api_keys use display_name;
// the rest use `name` except mcp_servers/a2a_agents which use display_name.
export const IDENTITY_FIELD = {
  provider_keys: 'display_name',
  models: 'display_name',
  api_keys: 'display_name',
  guardrails: 'name',
  mcp_servers: 'display_name',
  a2a_agents: 'display_name',
  cache_policies: 'name',
  observability_exporters: 'name',
  rate_limit_policies: 'name',
  oidc_providers: 'name',
  claim_mappings: 'name',
};

export function bootstrapTemplate() {
  const doc = { _format_version: '1' };
  for (const kind of KINDS) doc[kind] = [];
  return doc;
}

export function serialize(doc) {
  const ordered = { _format_version: doc._format_version ?? '1' };
  for (const kind of KINDS) {
    if (doc[kind] !== undefined) ordered[kind] = doc[kind];
  }
  return stringifyYaml(ordered, {
    lineWidth: 0,
    noRefs: true,
    sortMapEntries: false,
    defaultStringType: 'PLAIN',
  });
}

// Read + parse the file. Returns {ok, doc?, text, error?}.
// On parse failure doc is null but text is still returned so the raw editor works.
export function loadFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, exists: false, text: '', error: 'file_not_found' };
    }
    return { ok: false, exists: true, text: '', error: `read failed: ${e.message}` };
  }
  try {
    const doc = parseYaml(text, { uniqueKeys: true });
    return { ok: true, exists: true, doc, text };
  } catch (e) {
    return { ok: false, exists: true, text, error: `YAML 解析失败: ${e.message}` };
  }
}

// ---- async, cached loader -----------------------------------------------
// The console sits in the same container as the AISIX gateway and the
// resources.yaml lives on a bind-mounted volume (/etc/aisix). Bind mounts on
// some setups (notably Docker Desktop on Windows) can stall on synchronous
// reads after long uptime; because `fs.readFileSync` blocks the ENTIRE Node
// event loop, a single stalled read freezes the whole console (every page and
// API), while the gateway — which serves from in-memory state — keeps working.
//
// These helpers make the hot path (status polling every 5s) asynchronous and
// cache the parsed file keyed by mtime+size, so a slow volume only delays the
// one request touching it, never the whole process.
import { stat } from 'node:fs/promises';

const cache = new Map(); // filePath -> { mtimeMs, size, promise }

async function readTextAsync(filePath) {
  return fs.promises.readFile(filePath, 'utf8');
}

// Async read; throws on ENOENT/permission so callers can catch.
export async function readFileAsync(filePath) {
  const text = await readTextAsync(filePath);
  try {
    const doc = parseYaml(text, { uniqueKeys: true });
    return { ok: true, exists: true, doc, text };
  } catch (e) {
    return { ok: false, exists: true, text, error: `YAML 解析失败: ${e.message}` };
  }
}

// Async read with mtime+size caching. Cheap (non-blocking) `stat` gates the
// expensive parse; if the file is unchanged we return the prior result
// without re-reading. On a stalled volume the slow operation is the awaited
// `stat`/`readFile` — it does NOT block other requests.
export async function loadFileCached(filePath) {
  let st;
  try {
    st = await stat(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      cache.delete(filePath);
      return { ok: false, exists: false, text: '', error: 'file_not_found' };
    }
    return { ok: false, exists: true, text: '', error: `stat failed: ${e.message}` };
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(filePath);
  if (hit && hit.key === key) return hit.value;

  const result = await readFileAsync(filePath); // may throw on read error
  const entry = { key, value: result };
  cache.set(filePath, entry);
  return result;
}

export function identityOf(kind, entry) {
  return entry?.[IDENTITY_FIELD[kind]] ?? entry?.name ?? entry?.display_name ?? '';
}

// Find index of entry by identity within a collection array.
export function findIndex(collection, kind, identity) {
  if (!Array.isArray(collection)) return -1;
  return collection.findIndex((e) => identityOf(kind, e) === identity);
}

// Validate the document shape is the expected resources.yaml shape
// (every PRESENT kind is an array). Newer gateway versions may add kinds
// (e.g. claim_mappings) that an existing file predates, so a missing key is
// tolerated — normalizeDoc fills it with [].
export function isResourceDoc(doc) {
  return (
    doc &&
    typeof doc === 'object' &&
    !Array.isArray(doc) &&
    KINDS.every((kind) => doc[kind] === undefined || Array.isArray(doc[kind]))
  );
}

// Reorder a doc to canonical kind order and emit missing kinds as [].
export function normalizeDoc(doc) {
  const out = { _format_version: doc._format_version ?? '1' };
  for (const kind of KINDS) out[kind] = Array.isArray(doc[kind]) ? doc[kind] : [];
  return out;
}

// sha256 hex of the file contents + mtime, for external-edit detection.
// Synchronous variant — only for on-demand paths (save validation, resource
// list/detail). Do NOT call this from the status-poll hot path: a stalled
// bind mount would block the ENTIRE Node event loop and wedge the console.
export function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    return { mtimeMs: stat.mtimeMs, size: stat.size, sha256: sha256Hex(text) };
  } catch {
    return null;
  }
}

// Async variant for the status-poll hot path. A stalled bind mount only delays
// this one promise (never the event loop), and a hard timeout makes the
// endpoint return even if the volume is wedged — so the console can never be
// pinned into an unkillable `D` state by a slow /etc/aisix read.
export async function fingerprintAsync(filePath, timeoutMs = 15000) {
  const read = (async () => {
    const st = await fs.promises.stat(filePath);
    const text = await fs.promises.readFile(filePath, 'utf8');
    return { mtimeMs: st.mtimeMs, size: st.size, sha256: sha256Hex(text) };
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    return await Promise.race([read, timeout]);
  } catch {
    return null;
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}
