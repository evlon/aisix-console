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
export function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    return { mtimeMs: stat.mtimeMs, size: stat.size, sha256: sha256Hex(text) };
  } catch {
    return null;
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}
