// File-mode resources.yaml document model. The console's internal
// representation IS the file-mode (sugar) shape, so round-trips are lossless
// with respect to sugar. Never write canonical-only fields (id, etc.).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Canonical collection order emitted by the file loader. Mirrors aisix
// v1.5.0 `filesource::KINDS` (14 collections).
export const KINDS = [
  'provider_keys',
  'models',
  'api_keys',
  'guardrails',
  'guardrail_attachments',
  'mcp_servers',
  'a2a_agents',
  'cache_policies',
  'observability_exporters',
  'rate_limit_policies',
  'oidc_providers',
  'claim_mappings',
  'passthrough_routes',
  'mcp_auth_settings',
];

// Identity field name per kind (used for list/get/upsert/remove and
// duplicate detection). provider_keys/models/api_keys use display_name;
// mcp_servers/a2a_agents/passthrough_routes accept name-or-display_name
// (canonical spelling is `name`, see desugar.rs IdentityField); the rest
// use `name`. guardrail_attachments use a composite (guardrail_id +
// scope_type + scope_id) triple, and mcp_auth_settings is a per-file
// singleton with a fixed identity.
export const IDENTITY_FIELD = {
  provider_keys: 'display_name',
  models: 'display_name',
  api_keys: 'display_name',
  guardrails: 'name',
  guardrail_attachments: null, // composite: handled by identityOf/findIndex below
  mcp_servers: 'name',
  a2a_agents: 'name',
  cache_policies: 'name',
  observability_exporters: 'name',
  rate_limit_policies: 'name',
  oidc_providers: 'name',
  claim_mappings: 'name',
  passthrough_routes: 'name',
  mcp_auth_settings: null, // singleton: fixed identity "mcp_auth_settings"
};

// Composite / fixed identities for kinds whose identity is not a single
// plain field (guardrail_attachments triple, mcp_auth_settings singleton).
export const FIXED_IDENTITIES = {
  mcp_auth_settings: 'mcp_auth_settings',
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
  // Preserve any top-level keys we do not recognize (future aisix
  // collections) so an edit never silently drops a collection this build
  // predates. Known kinds stay in canonical order above; unknowns append
  // after them.
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_format_version' || KINDS.includes(k) || ordered[k] !== undefined) continue;
    ordered[k] = v;
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
  if (kind === 'mcp_auth_settings') {
    return FIXED_IDENTITIES.mcp_auth_settings;
  }
  if (kind === 'guardrail_attachments') {
    // Composite identity: guardrail_id + scope_type (+ scope_id; `-` for
    // absent, matching desugar.rs IdentityField::AttachmentTriple).
    const g = entry?.guardrail_id ?? '';
    const t = entry?.scope_type ?? '';
    const s = entry?.scope_id ?? '-';
    return `${g}/${t}/${s}`;
  }
  const field = IDENTITY_FIELD[kind];
  if (field) return entry?.[field] ?? '';
  // Fallback for kinds keyed by name-or-display_name: prefer name.
  return entry?.name ?? entry?.display_name ?? '';
}

// Find index of entry by identity within a collection array.
export function findIndex(collection, kind, identity) {
  if (!Array.isArray(collection)) return -1;
  return collection.findIndex((e) => identityOf(kind, e) === identity);
}

// Return the plain identity FIELD (for CRUD routes that read/write a single
// field). Returns null for composite/singleton identities.
export function identityFieldOf(kind) {
  if (kind === 'mcp_auth_settings' || kind === 'guardrail_attachments') return null;
  return IDENTITY_FIELD[kind] ?? 'name';
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

// Reorder a doc to canonical kind order, emit missing kinds as [], and
// preserve unknown top-level keys (future aisix collections) verbatim.
export function normalizeDoc(doc) {
  const out = { _format_version: doc._format_version ?? '1' };
  for (const kind of KINDS) out[kind] = Array.isArray(doc[kind]) ? doc[kind] : [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_format_version' || KINDS.includes(k)) continue;
    out[k] = v;
  }
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

// ── Derived resource ids (mirror aisix filesource::derive_id) ─────────────
// Every file-mode entry gets `uuid5(FILE_RESOURCE_NAMESPACE, "<kind>/<identity>")`
// as its canonical id. The console writes only sugar (name references) into
// YAML, so it normally never needs these — EXCEPT where upstream has no name
// sugar for a reference. The one such field is
// `mcp_auth_settings.anonymous.api_key_id`, which must be the derived UUID of
// an api_key (see glama/resources.yaml). We re-derive it here so the UI can
// offer a name picker instead of forcing operators to paste a UUID.
//
// FILE_RESOURCE_NAMESPACE pinned in aisix (desugar.rs), derived once as
// uuid5(NAMESPACE_URL, "https://github.com/api7/aisix#resources-file").
const FILE_RESOURCE_NAMESPACE_BYTES = new Uint8Array([
  0x63, 0xe5, 0x0a, 0xb2, 0x67, 0x7a, 0x54, 0xd3,
  0x8d, 0x1e, 0xc0, 0xcb, 0x29, 0xce, 0xae, 0x94,
]);

// Deterministic RFC-4122 UUIDv5. Matches aisix's `Uuid::new_v5` byte-for-byte.
export function uuid5(namespaceBytes, name) {
  const nameBuf = Buffer.from(name, 'utf8');
  const input = Buffer.concat([Buffer.from(namespaceBytes), nameBuf]);
  const hash = createHash('sha1').update(input).digest(); // 20 bytes
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Derived canonical id for a file-mode entry: uuid5(namespace, "<kind>/<identity>").
// `identity` is the file-side identity string (see identityOf).
export function deriveId(kind, identity) {
  return uuid5(FILE_RESOURCE_NAMESPACE_BYTES, `${kind}/${identity}`);
}
