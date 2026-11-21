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

// ── File format versions ─────────────────────────────────────────────────
// v1 ("sugar"): rows carry no id, references are names. aisix <= 1.10.
// v2 (etcd-document): every row carries the resource's UUID as `id`, and
//   references are ids. MANDATORY from aisix 1.11 — commit `#1449`
//   ("feat(file-source)!") made `_format_version` a hard equality check and
//   deleted the name→id sugar layer (`desugar.rs`, `derive_id`).
//
// The two formats are mutually exclusive on the gateway side: a v1 file on an
// aisix >= 1.11 fails the whole load ("unrecognized _format_version \"1\"
// (supported: \"2\")"), and a v2 file on aisix <= 1.10 fails the same check in
// the other direction. So the console PRESERVES whatever the file declares and
// only switches format through an explicit, operator-initiated migration.
export const FORMAT_VERSION_V1 = '1';
export const FORMAT_VERSION_V2 = '2';

export function formatVersionOf(doc) {
  return doc?._format_version === FORMAT_VERSION_V2 ? FORMAT_VERSION_V2 : FORMAT_VERSION_V1;
}

// v1 name references that v2 expresses as ids: `<kind>.<field>` -> the
// collection the field points into. Only `models.provider_key` needs it —
// `RoutingTarget.model` still accepts a model alias in v2 (its `model_id` is
// optional and merely authoritative when present).
const NAME_REFERENCE_FIELDS = [
  { kind: 'models', field: 'provider_key', target: 'provider_keys' },
];

function orderIdFirst(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const { id, ...rest } = row;
  return id === undefined ? row : { id, ...rest };
}

// Give every row an `id`, deriving it from the row's identity when absent.
//
// The derived value is exactly what aisix <= 1.10 computed for the same row
// (`uuid5(FILE_RESOURCE_NAMESPACE, "<kind>/<identity>")`), which is what makes
// a v1 -> v2 migration id-preserving: provider_key_id / api_key_id values in
// metrics, access logs and budget accounting continue to name the same
// resource instead of churning on upgrade.
export function assignIds(doc) {
  const out = { ...doc };
  const fill = (container, kinds) => {
    const next = { ...container };
    for (const kind of kinds) {
      const rows = container?.[kind];
      if (!Array.isArray(rows)) continue;
      next[kind] = rows.map((row) => {
        const ordered = orderIdFirst(row);
        if (!ordered || typeof ordered !== 'object') return ordered;
        if (typeof ordered.id === 'string' && ordered.id) return ordered;
        const identity = identityOf(kind, ordered);
        return identity ? { id: deriveId(kind, identity), ...ordered } : ordered;
      });
    }
    return next;
  };
  Object.assign(out, fill(doc, KINDS));
  // The shared `global` prefix holds documents for every collection too.
  if (doc && typeof doc.global === 'object' && !Array.isArray(doc.global)) {
    out.global = fill(doc.global, KINDS);
  }
  return out;
}

// Rewrite v1 name references into v2 id references, using the ids already
// present in `doc` (so call assignIds first).
export function toIdReferences(doc) {
  let out = doc;
  for (const { kind, field, target } of NAME_REFERENCE_FIELDS) {
    const rows = out?.[kind];
    if (!Array.isArray(rows)) continue;
    const byName = new Map();
    for (const row of out[target] ?? []) {
      if (row && typeof row === 'object' && row.display_name !== undefined) {
        byName.set(row.display_name, row.id ?? deriveId(target, row.display_name));
      }
    }
    const idField = `${field}_id`;
    out = {
      ...out,
      [kind]: rows.map((row) => {
        if (!row || typeof row !== 'object' || row[field] === undefined) return row;
        const { [field]: name, ...rest } = row;
        const id = byName.get(name);
        // An unresolvable name is left untouched so `aisix validate` names the
        // bad reference, rather than us inventing an id that points nowhere.
        return id ? { ...rest, [idField]: id } : { [field]: name, ...rest };
      }),
    };
  }
  return out;
}

// v1 -> v2, the whole transformation. Idempotent: a document that is already
// v2 (every row has an id, references are ids) comes back unchanged.
export function migrateToV2(doc) {
  const withIds = assignIds(doc);
  const referenced = toIdReferences(withIds);
  const { _format_version: _ignored, ...rest } = referenced;
  return { _format_version: FORMAT_VERSION_V2, ...rest };
}

// Keep each row's id across an ordinary save.
//
// The per-kind forms build an entry field by field, so `id` does not survive a
// round-trip through them. Without this, every edit would re-derive the id and
// — after a rename — silently re-key the resource, orphaning whatever was
// keyed by the old id (budget rows, metric series, log history). Matching is by
// identity against the file being replaced, which is the same identity v1 used.
export function reconcileIds(prevDoc, nextDoc) {
  if (!prevDoc || formatVersionOf(nextDoc) !== FORMAT_VERSION_V2) return nextDoc;
  const out = { ...nextDoc };
  const fill = (container, prevContainer) => {
    const next = { ...container };
    for (const kind of KINDS) {
      const rows = container?.[kind];
      if (!Array.isArray(rows)) continue;
      const prevIds = new Map();
      for (const row of prevContainer?.[kind] ?? []) {
        if (row && typeof row === 'object' && row.id) prevIds.set(identityOf(kind, row), row.id);
      }
      next[kind] = rows.map((row) => {
        if (!row || typeof row !== 'object' || (typeof row.id === 'string' && row.id)) {
          return orderIdFirst(row);
        }
        const kept = prevIds.get(identityOf(kind, row));
        const id = kept ?? deriveId(kind, identityOf(kind, row));
        return orderIdFirst({ id, ...row });
      });
    }
    return next;
  };
  Object.assign(out, fill(nextDoc, prevDoc));
  if (nextDoc?.global && typeof nextDoc.global === 'object' && !Array.isArray(nextDoc.global)) {
    out.global = fill(nextDoc.global, prevDoc?.global);
  }
  return out;
}

// True when `validate` output is the format-version mismatch, so callers can
// turn a bare gateway error into an actionable message.
export function isFormatVersionMismatch(text) {
  return /unrecognized _format_version/i.test(String(text ?? ''));
}

// ── Name <-> id reference translation ────────────────────────────────────
// A v1 file names the thing a row points at; a v2 file carries its UUID. The
// views keep the v1 spelling (a name picker is far easier to use than a uuid
// box), so the translation happens at the API boundary: `externalizeRefs` on
// the way out, `internalizeRefs` on the way in.
//
// Upstream removed the sugar layer in 1.11, so on a v2 file the id spelling is
// the ONLY thing the gateway accepts — writing the name would be an unknown
// field. Adding a reference field later is one entry in this table.
const REFERENCE_FIELDS = [
  { kind: 'models', name: 'provider_key', id: 'provider_key_id', target: 'provider_keys' },
];

function targetIdByName(doc, target, name) {
  for (const row of doc?.[target] ?? []) {
    if (row && typeof row === 'object' && row.display_name === name) {
      return row.id ?? deriveId(target, name);
    }
  }
  return null;
}

function targetNameById(doc, target, id) {
  for (const row of doc?.[target] ?? []) {
    if (!row || typeof row !== 'object') continue;
    if (row.id === id) return row.display_name ?? null;
    if (!row.id && row.display_name !== undefined && deriveId(target, row.display_name) === id) {
      return row.display_name;
    }
  }
  return null;
}

// Server -> view: present an id reference under its v1 name, so a v2 file does
// not turn every provider-key picker into a raw uuid.
export function externalizeRefs(kind, entry, doc) {
  const specs = REFERENCE_FIELDS.filter((s) => s.kind === kind);
  if (!specs.length || !entry || typeof entry !== 'object') return entry;
  let out = { ...entry };
  for (const { name, id, target } of specs) {
    if (out[name] !== undefined || out[id] === undefined) continue;
    const resolved = targetNameById(doc, target, out[id]);
    if (resolved == null) continue; // keep the raw id rather than show nothing
    const { [id]: _dropped, ...rest } = out;
    out = { [name]: resolved, ...rest };
  }
  return out;
}

// View -> server: write the spelling the file's format version requires.
export function internalizeRefs(kind, entry, doc, formatVersion) {
  const specs = REFERENCE_FIELDS.filter((s) => s.kind === kind);
  if (!specs.length || !entry || typeof entry !== 'object') return entry;
  let out = { ...entry };
  for (const { name, id, target } of specs) {
    const hasName = out[name] !== undefined;
    const hasId = out[id] !== undefined;
    if (!hasName && !hasId) continue;
    const value = hasName ? out[name] : out[id];
    // Both spellings are removed, then exactly one is written back, so a stale
    // copy can never ride along as an unknown field.
    const { [name]: _name, [id]: _id, ...rest } = out;
    if (formatVersion === FORMAT_VERSION_V2) {
      const resolved = hasName ? targetIdByName(doc, target, value) : value;
      out = resolved ? { ...rest, [id]: resolved } : { ...rest, [name]: value };
    } else {
      // v1 references by name, so an id coming from a v2-shaped form is
      // resolved back rather than dropped.
      const asName = hasName ? value : targetNameById(doc, target, value);
      out = asName ? { ...rest, [name]: asName } : rest;
    }
  }
  return out;
}

// A named reference that does not exist (v2 only — v1 lets the gateway's own
// loader report it). Returns a message for the route to reject with, else null.
export function unresolvedReference(kind, entry, doc, formatVersion) {
  if (formatVersion !== FORMAT_VERSION_V2) return null;
  for (const { kind: k, name, target } of REFERENCE_FIELDS) {
    if (k !== kind) continue;
    const value = entry?.[name];
    if (value === undefined || value === '') continue;
    if (targetIdByName(doc, target, value) == null) {
      return `${name} "${value}" 不存在 —— 请先在「上游密钥」里创建它，或改成已有名称`;
    }
  }
  return null;
}
