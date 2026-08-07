const BASE = import.meta.env.VITE_WORKER_URL
  ?? 'https://ebp-tracker-worker.aicube-apps.workers.dev';

const ADMIN_BASE = import.meta.env.VITE_ADMIN_WORKER_URL
  ?? 'https://admin-worker.aicube-apps.workers.dev';

const NSE_BASE = import.meta.env.VITE_NSE_WORKER_URL
  ?? 'https://nse-tracker.aicube-apps.workers.dev';

// /admin/* routes live on admin-worker, /nse/* and NSE indicator config
// routes live on nse-worker, everything else stays on the main EBP worker —
// picked per-call since this module has one generic request() shared by
// every endpoint, not one function per route.
function baseFor(path) {
  if (path.startsWith('/admin')) return ADMIN_BASE;
  if (path.startsWith('/nse/') || path.startsWith('/user/nse-indicator-configs')) return NSE_BASE;
  return BASE;
}

async function request(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseFor(path)}${path}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `API error ${res.status}`);
  return data;
}

const api = {
  get:    (path, token)       => request('GET',    path, null, token),
  post:   (path, body, token) => request('POST',   path, body, token),
  patch:  (path, body, token) => request('PATCH',  path, body, token),
  delete: (path, token)       => request('DELETE', path, null, token),
};

export default api;
