const BASE = import.meta.env.VITE_WORKER_URL
  ?? 'https://ebp-tracker-worker.aicube-apps.workers.dev';

async function request(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
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
