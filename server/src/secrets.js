// secrets.env store — console-owned environment variables referenced from
// resources.yaml as ${VAR}. Values never leave the backend.
import fs from 'node:fs';
import path from 'node:path';

let map = new Map();
let filePath = '';
let dirty = false;

export function init(secretsFilePath) {
  filePath = secretsFilePath;
  map = new Map();
  if (fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key) map.set(key, value);
    }
  }
}

function persist() {
  if (!filePath) return;
  const lines = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function slugFrom(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'KEY';
}

// Allocate a unique var name with the given prefix + slug, storing value.
export function allocate(prefix, displayName, value) {
  const base = `${prefix}_${slugFrom(displayName)}`;
  let name = base;
  let i = 2;
  while (map.has(name)) {
    name = `${base}_${i++}`;
  }
  map.set(name, value);
  dirty = true;
  persist();
  return name;
}

export function set(name, value) {
  map.set(name, value);
  dirty = true;
  persist();
}

export function get(name) {
  return map.get(name);
}

export function has(name) {
  return map.has(name);
}

export function remove(name) {
  if (map.delete(name)) {
    dirty = true;
    persist();
    return true;
  }
  return false;
}

// Names only — never values.
export function listNames() {
  return [...map.keys()].sort();
}

// Flat object of all secrets for injecting into the validate subprocess env.
export function envForValidate() {
  return Object.fromEntries(map);
}

export function isDirty() {
  return dirty;
}
