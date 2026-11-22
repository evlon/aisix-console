// Applying a submitted resource entry to the stored one.
//
// WHY THIS EXISTS
// PUT /:kind/:identity used to do `arr[idx] = entry` — replace the row
// wholesale. But the console's forms model only part of each resource: the
// API-key form had no tpm/tpd, and it rebuilt `rate_limit` from scratch as
// `{ rpm }`. So an operator renaming a key silently deleted the token cap that
// stops one caller from consuming the whole quota, and got HTTP 200 with
// "saved" on screen. Reproduced: rate_limit {rpm,tpm,concurrency,rpd,tpd}
// became {rpm} after a form-shaped PUT.
//
// The entry the form submits is therefore a PARTIAL update, and the default
// here is "apply what was submitted, keep everything else". A caller that
// really means "this is the whole entry" must say so — the raw-YAML tab does,
// because editing raw YAML is exactly how you remove a field by hand.
//
// Arrays and scalars replace; only plain objects recurse. Arrays must not be
// merged, or removing one entry from a list would be impossible.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Apply `submitted` over `stored`.
 *
 * A key present in `submitted` with the value `null` is DELETED. Without that,
 * switching to a merge would make a field impossible to clear from a form —
 * trading one silent surprise for another, which is the mistake this module
 * exists to avoid. Callers that model a field must therefore send `null` to
 * clear it and simply omit the fields they do not model.
 */
export function mergeEntry(stored, submitted) {
  if (!isPlainObject(stored) || !isPlainObject(submitted)) {
    return submitted === null ? undefined : submitted;
  }
  const out = { ...stored };
  for (const [key, value] of Object.entries(submitted)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeEntry(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Leaf paths that existed in `stored`, were not mentioned in `submitted`, and
 * are therefore kept by the merge.
 *
 * Reported to the operator because the merge's whole point is that the form's
 * silence is no longer destructive — so it must not be invisible either. This
 * is also the honest answer to "did my save do what I meant".
 *
 * PATHS ONLY, NEVER VALUES: `provider_keys[].api_key` and `mcp_servers.secret`
 * are stored in plaintext in this file, and a save response must not become a
 * way to read them back.
 */
export function preservedPaths(stored, submitted, limit = 20) {
  const out = [];
  const walk = (base, sub, prefix) => {
    for (const [key, value] of Object.entries(base)) {
      if (out.length >= limit) return;
      const path = prefix ? `${prefix}.${key}` : key;
      const subValue = isPlainObject(sub) ? sub[key] : undefined;
      // `undefined` means "not mentioned"; an explicit null means "delete",
      // which is a decision the caller made, not something preserved.
      if (subValue === undefined) {
        if (isPlainObject(value)) walk(value, undefined, path);
        else out.push(path);
        continue;
      }
      if (isPlainObject(value) && isPlainObject(subValue)) walk(value, subValue, path);
    }
  };
  walk(isPlainObject(stored) ? stored : {}, submitted, '');
  return out;
}
