// File-mode resources.yaml document model. The console's internal
// representation IS the file-mode (sugar) shape, so round-trips are lossless
// with respect to sugar. Never write canonical-only fields (id, etc.).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Canonical collection order emitted by the file loader.
//
// The first fourteen mirror aisix v1.5.0 `filesource::KINDS`. The rest are
// collections aisix added afterwards (they are `Resource::kind()` values, and
// all seven load fine from a resources file — verified against the 1.11.0
// binary). They are APPENDED rather than interleaved so an existing file keeps
// its layout when the console rewrites it; the order is cosmetic either way,
// since the file is a set of rows.
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
  // aisix >= 1.9 collections the console now lists as well.
  'teams',
  'users',
  'pricing',
  'budgets',
  'budget_policy',
  'usage_accounting',
  'mcp_policies',
];

// Identity field name per kind (used for list/get/upsert/remove and
// duplicate detection). provider_keys/models/api_keys use display_name;
// mcp_servers/a2a_agents/passthrough_routes accept name-or-display_name
// (canonical spelling is `name`); the rest use `name`. `null` means the kind
// has no single-field identity — see identityOf below.
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
  // Newer collections.
  teams: 'name',
  users: 'name',
  pricing: 'key', // `pricing` is keyed by its lookup key, not by a name
  budgets: null, // composite: scope + scope_ref
  budget_policy: null, // singleton
  usage_accounting: null, // singleton
  mcp_policies: null, // composite: scope + scope_ref
};

// Kinds with exactly one document per file.
export const FIXED_IDENTITIES = {
  mcp_auth_settings: 'mcp_auth_settings',
  budget_policy: 'budget_policy',
  usage_accounting: 'usage_accounting',
};

// Kinds identified by a combination of fields.
const COMPOSITE_IDENTITIES = {
  budgets: (e) =>
    e?.scope === 'tag'
      ? `tag:${e?.tag?.key ?? ''}=${e?.tag?.value ?? ''}`
      : `${e?.scope ?? ''}:${e?.scope_ref ?? ''}`,
  mcp_policies: (e) => (e?.scope === 'team' ? `team:${e?.scope_ref ?? ''}` : 'env'),
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
  if (FIXED_IDENTITIES[kind]) return FIXED_IDENTITIES[kind];
  if (COMPOSITE_IDENTITIES[kind]) return COMPOSITE_IDENTITIES[kind](entry);
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
  if (IDENTITY_FIELD[kind] === null) return null;
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
// present in `doc` (so call assignIds first). It drives the same REFERENCES
// table as `internalizeRefs`, so a reference added there is migrated too.
export function toIdReferences(doc) {
  const out = { ...doc };
  const table = (container) => {
    const next = { ...container };
    for (const kind of KINDS) {
      const rows = container?.[kind];
      if (!Array.isArray(rows)) continue;
      // Look the reference up in the whole id-assigned input, not in the
      // partially rewritten output.
      next[kind] = rows.map((row) =>
        row && typeof row === 'object' ? internalizeRefs(kind, row, doc, FORMAT_VERSION_V2) : row,
      );
    }
    return next;
  };
  Object.assign(out, table(doc));
  if (doc?.global && typeof doc.global === 'object' && !Array.isArray(doc.global)) {
    out.global = table(doc.global);
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
// views keep the v1 spelling (a name picker beats a uuid box), so translation
// happens at the API boundary: `externalizeRefs` on the way out,
// `internalizeRefs` on the way in.
//
// Upstream removed the sugar layer in 1.11, so on a v2 file the id spelling is
// the ONLY thing the gateway accepts — a name is an unknown value, and for the
// embedded string forms it is silently the wrong lookup key.
//
// Each entry is one reference. Three shapes are covered:
//   - renamed field      v1 `provider_key`        -> v2 `provider_key_id`
//   - same field, new value  `guardrail_id` holds a name in v1, a uuid in v2
//   - embedded in a string   `applies_to: "api_key:<ref>"`
// Sources for what v2 expects (aisix 1.11.0):
//   crates/aisix-core/src/models/cache_policy.rs  applies_to supports
//     "model:<name>" but "api_key:<id>"
//   crates/aisix-core/src/models/budget.rs        scope_ref for api_key is an id
//   schemas/resources/*.schema.json               which fields are uuids
const REFERENCES = [
  { kind: 'models', field: 'provider_key', idField: 'provider_key_id', target: 'provider_keys' },
  { kind: 'passthrough_routes', field: 'provider_key', idField: 'provider_key_id', target: 'provider_keys' },
  { kind: 'passthrough_routes', field: 'anonymous_key', idField: 'anonymous_key_id', target: 'api_keys' },
  { kind: 'claim_mappings', field: 'resolve.api_key', idField: 'resolve.api_key_id', target: 'api_keys' },
  { kind: 'guardrail_attachments', field: 'guardrail_id', target: 'guardrails' },
  {
    kind: 'guardrail_attachments',
    field: 'scope_id',
    // The scope id points into whichever collection `scope_type` names.
    targetFrom: {
      field: 'scope_type',
      map: {
        model: 'models',
        mcp_server: 'mcp_servers',
        api_key: 'api_keys',
        team: 'teams',
        passthrough_route: 'passthrough_routes',
      },
    },
  },
  { kind: 'rate_limit_policies', field: 'scope_ref', target: 'api_keys', when: (row) => row.scope === 'api_key' },
  { kind: 'cache_policies', field: 'applies_to', target: 'api_keys', embed: 'api_key:' },
  // budgets.rs: `scope_ref` is "the id of the capped resource", and which
  // collection that is depends on `scope` (absent for `org`/`environment`/`tag`).
  {
    kind: 'budgets',
    field: 'scope_ref',
    targetFrom: {
      field: 'scope',
      map: {
        api_key: 'api_keys',
        member: 'users',
        team: 'teams',
        team_member: 'teams',
        provider_key: 'provider_keys',
      },
    },
  },
  // mcp_policy.rs: scope is `env` (no ref) or `team` (scope_ref names the team).
  { kind: 'mcp_policies', field: 'scope_ref', target: 'teams', when: (row) => row.scope === 'team' },
];

function getPath(obj, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

// Clone along the path so callers never mutate the row they were handed.
function withPath(row, path, value) {
  const parts = path.split('.');
  const clone = { ...row };
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') return row; // path absent: nothing to rewrite
    cur[k] = { ...cur[k] };
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
}

// Remove a (possibly nested) field. A missing path is a no-op.
function dropPath(row, path) {
  const parts = path.split('.');
  if (parts.length === 1) {
    const { [path]: _dropped, ...rest } = row;
    return rest;
  }
  const parentPath = parts.slice(0, -1).join('.');
  const parent = getPath(row, parentPath);
  if (!parent || typeof parent !== 'object') return row;
  const { [parts[parts.length - 1]]: _dropped, ...parentRest } = parent;
  return withPath(row, parentPath, parentRest);
}

// Look the reference up in the collection it points into, using that kind's own
// identity field (`display_name` for provider keys / api keys / models, `name`
// for guardrails / mcp servers / passthrough routes). A row without an explicit
// id still resolves through the derived id, so a v1 file (no ids) and a v2 file
// (ids) both answer.
function targetIdByName(doc, target, name) {
  for (const row of doc?.[target] ?? []) {
    if (!row || typeof row !== 'object') continue;
    if (identityOf(target, row) === name) return row.id ?? deriveId(target, name);
  }
  return null;
}

function targetNameById(doc, target, id) {
  for (const row of doc?.[target] ?? []) {
    if (!row || typeof row !== 'object') continue;
    const identity = identityOf(target, row);
    if (row.id === id) return identity;
    if (!row.id && identity && deriveId(target, identity) === id) return identity;
  }
  return null;
}

function targetsFor(spec, row) {
  if (spec.when && !spec.when(row)) return null;
  if (spec.target) return spec.target;
  const which = getPath(row, spec.targetFrom.field);
  return spec.targetFrom.map[which] ?? null;
}

function resolveTargetId(doc, target, ref) {
  return ref ? targetIdByName(doc, target, ref) : null;
}

// Server -> view: present each id reference under its v1 spelling.
export function externalizeRefs(kind, entry, doc) {
  const specs = REFERENCES.filter((s) => s.kind === kind);
  if (!specs.length || !entry || typeof entry !== 'object') return entry;
  let out = { ...entry };
  for (const spec of specs) {
    const target = targetsFor(spec, out);
    if (!target) continue;
    const readPath = spec.idField ?? spec.field;

    if (spec.embed) {
      // "<prefix><ref>" — translate the ref part, keep the prefix.
      const raw = getPath(out, spec.field);
      if (typeof raw !== 'string' || !raw.startsWith(spec.embed)) continue;
      const name = targetNameById(doc, target, raw.slice(spec.embed.length));
      if (name != null) out = withPath(out, spec.field, spec.embed + name);
      continue;
    }

    const value = getPath(out, readPath);
    if (value === undefined || value === '') continue;
    // Already v1-shaped (a name we can see in the collection)? Leave it.
    if (typeof value === 'string' && targetIdByName(doc, target, value) != null) continue;
    const name = targetNameById(doc, target, value);
    if (name == null) continue; // unresolvable: keep the raw uuid rather than blank it

    if (readPath === spec.field) {
      out = withPath(out, spec.field, name);
    } else {
      out = withPath(dropPath(out, readPath), spec.field, name);
    }
  }
  return out;
}

// View -> server: write the spelling the file's format version requires.
export function internalizeRefs(kind, entry, doc, formatVersion) {
  const specs = REFERENCES.filter((s) => s.kind === kind);
  if (!specs.length || !entry || typeof entry !== 'object') return entry;
  const v2 = formatVersion === FORMAT_VERSION_V2;
  let out = { ...entry };
  for (const spec of specs) {
    const target = targetsFor(spec, out);
    if (!target) continue;

    if (spec.embed) {
      const raw = getPath(out, spec.field);
      if (typeof raw !== 'string' || !raw.startsWith(spec.embed)) continue;
      const ref = raw.slice(spec.embed.length);
      const resolved = v2 ? (resolveTargetId(doc, target, ref) ?? ref) : (targetNameById(doc, target, ref) ?? ref);
      out = withPath(out, spec.field, spec.embed + resolved);
      continue;
    }

    const idPath = spec.idField ?? spec.field;
    const value = getPath(out, spec.field) ?? getPath(out, idPath);
    // Both spellings are removed first, so a stale copy can never ride along as
    // an unknown field, then exactly one is written back.
    for (const p of new Set([spec.field, idPath])) out = dropPath(out, p);
    if (value === undefined || value === '') continue;

    const toPath = v2 ? idPath : spec.field;
    // Resolve to the target's id (v2) or name (v1); a value that is already in
    // the wanted form simply passes through unresolved.
    const resolved = v2
      ? (resolveTargetId(doc, target, value) ?? value)
      : (targetNameById(doc, target, value) ?? value);
    out = withPath(out, toPath, resolved);
  }
  return out;
}

// A named reference that does not exist (v2 only — v1 lets the gateway's own
// loader report it). Returns a message for the route to reject with, else null.
export function unresolvedReference(kind, entry, doc, formatVersion) {
  if (formatVersion !== FORMAT_VERSION_V2) return null;
  for (const spec of REFERENCES.filter((s) => s.kind === kind)) {
    const target = targetsFor(spec, entry);
    if (!target) continue;
    const raw = getPath(entry, spec.field);
    if (raw === undefined || raw === '') continue;
    if (spec.embed) {
      // Only the literal `api_key:` form is a reference; `all` and
      // `model:<name>` are not.
      if (typeof raw !== 'string' || !raw.startsWith(spec.embed)) continue;
      const ref = raw.slice(spec.embed.length);
      if (targetIdByName(doc, target, ref) == null && targetNameById(doc, target, ref) == null) {
        return `${spec.field} "${raw}" 指向的引用不存在`;
      }
      continue;
    }
    if (typeof raw !== 'string') continue;
    if (targetIdByName(doc, target, raw) == null && targetNameById(doc, target, raw) == null) {
      return `${spec.field} "${raw}" 不存在 —— 请先创建它，或改成已有名称`;
    }
  }
  return null;
}
