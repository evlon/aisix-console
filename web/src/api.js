// fetch wrapper for /api/* — JSON in/out, throws {status, message} on non-2xx.
async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  status: () => request('/api/status'),
  raw: () => request('/api/raw'),

  list: (kind) => request(`/api/resources/${kind}`),
  get: (kind, identity) => request(`/api/resources/${kind}/${encodeURIComponent(identity)}`),
  create: (kind, entry) => request(`/api/resources/${kind}`, { method: 'POST', body: JSON.stringify({ entry }) }),
  update: (kind, identity, entry) =>
    request(`/api/resources/${kind}/${encodeURIComponent(identity)}`, {
      method: 'PUT',
      body: JSON.stringify({ entry }),
    }),
  remove: (kind, identity) =>
    request(`/api/resources/${kind}/${encodeURIComponent(identity)}`, { method: 'DELETE' }),

  saveRaw: (text) => request('/api/resources/raw', { method: 'PUT', body: JSON.stringify({ text }) }),
  bootstrap: () => request('/api/resources/bootstrap', { method: 'POST' }),

  secrets: () => request('/api/secrets'),
  setSecret: (name, value) => request('/api/secrets', { method: 'POST', body: JSON.stringify({ name, value }) }),
  deleteSecret: (name) => request(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  playground: (body) => request('/api/playground/chat', { method: 'POST', body: JSON.stringify(body) }),

  health: () => request('/api/health'),
};
