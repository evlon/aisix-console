// Gateway fetch helpers — each accessor returns {reachable, data?, error?}
// and never throws, so the status endpoint is tolerant of a down gateway.
const DEFAULT_TIMEOUT_MS = 2000;

export async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export function makeGatewayClient(cfg) {
  const headers = (extra = {}) =>
    cfg.gateway.adminKey
      ? { ...extra, Authorization: `Bearer ${cfg.gateway.adminKey}` }
      : extra;

  async function statusConfig() {
    const r = await fetchWithTimeout(`${cfg.gateway.metrics}/status/config`);
    return r.ok ? { reachable: true, data: r.data } : { reachable: false, error: `HTTP ${r.status}` };
  }

  async function statusModels() {
    const r = await fetchWithTimeout(`${cfg.gateway.metrics}/status/models`);
    return r.ok ? { reachable: true, data: r.data } : { reachable: false, error: `HTTP ${r.status}` };
  }

  async function statusReady() {
    const r = await fetchWithTimeout(`${cfg.gateway.metrics}/status/ready`);
    return { reachable: r.ok, status: r.status, data: r.data };
  }

  async function adminHealth() {
    if (!cfg.gateway.adminKey) return { reachable: false, skipped: true };
    const r = await fetchWithTimeout(`${cfg.gateway.admin}/admin/v1/health`, { headers: headers() });
    return r.ok ? { reachable: true, data: r.data } : { reachable: false, error: `HTTP ${r.status}` };
  }

  async function adminList(kind) {
    if (!cfg.gateway.adminKey) return { reachable: false, skipped: true };
    const r = await fetchWithTimeout(`${cfg.gateway.admin}/admin/v1/${kind}`, { headers: headers() });
    return r.ok ? { reachable: true, data: r.data } : { reachable: false, error: `HTTP ${r.status}` };
  }

  return { statusConfig, statusModels, statusReady, adminHealth, adminList };
}
