// SHA-256 (lowercase hex) for caller API keys.
//
// WebCrypto's `crypto.subtle` only exists in a *secure context* (HTTPS or
// localhost). This console is commonly deployed over plain HTTP on an
// intranet, where `crypto.subtle` is undefined and digesting throws
// "Cannot read properties of undefined (reading 'digest')". In that case we
// fall back to the backend, which hashes with Node's built-in crypto — the
// plaintext still never gets written to resources.yaml, only the digest.
const hasSubtle = () =>
  typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.digest === 'function';

async function sha256ViaBackend(text) {
  const res = await fetch('/api/util/sha256', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = await res.json();
      if (d?.error) msg = d.error;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data?.hash) throw new Error('后端未返回 hash');
  return data.hash;
}

export async function sha256Hex(text) {
  if (!hasSubtle()) return sha256ViaBackend(text);
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
