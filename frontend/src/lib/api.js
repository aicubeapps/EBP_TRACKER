const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787';

async function request(path, options = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${WORKER_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get:    (path, token)        => request(path, { method: 'GET' }, token),
  post:   (path, body, token)  => request(path, { method: 'POST',   body: JSON.stringify(body) }, token),
  patch:  (path, body, token)  => request(path, { method: 'PATCH',  body: JSON.stringify(body) }, token),
  del:    (path, token)        => request(path, { method: 'DELETE' }, token),
};
