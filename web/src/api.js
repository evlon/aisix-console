// fetch wrapper for /api/* — JSON in/out, throws {status, message} on non-2xx.
// A 401 (except on auth endpoints) triggers the registered onUnauthorized
// callback so the app can bounce to the login page.

let onUnauthorized = null;
export function setOnUnauthorized(fn) {
  onUnauthorized = fn;
}

const AUTH_PATHS = ['/api/auth/login', '/api/auth/status', '/api/auth/logout'];

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
    if (res.status === 401 && !AUTH_PATHS.includes(url) && onUnauthorized) {
      onUnauthorized();
    }
    throw err;
  }
  return data;
}

export const api = {
  // auth
  authStatus: () => request('/api/auth/status'),
  login: (password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  changePassword: (current_password, new_password) =>
    request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),

  status: () => request('/api/status'),
  raw: () => request('/api/raw'),

  list: (kind) => request(`/api/resources/${kind}`),
  get: (kind, identity) => request(`/api/resources/${kind}/${encodeURIComponent(identity)}`),
  listProviderModels: (name) => request(`/api/provider-models/${encodeURIComponent(name)}`),
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
