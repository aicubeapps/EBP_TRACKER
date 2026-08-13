// ============================================================
// Admin Worker — Zero Dependencies Bundle
// Uses native Workers fetch API only — no npm imports
// Absorbs all /admin/* routes from worker/src/ebp-worker.js.
// ============================================================

// ============================================================
// CORS helper
// ============================================================
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://ebp-tracker.pages.dev',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function getOrigin(request) {
  return request.headers.get('Origin') ?? '';
}

// ============================================================
// Router
// ============================================================
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, ...handlers) {
    this.routes.push({ method, path, handlers });
  }

  get(path, ...handlers)    { this.add('GET',    path, ...handlers); }
  post(path, ...handlers)   { this.add('POST',   path, ...handlers); }
  patch(path, ...handlers)  { this.add('PATCH',  path, ...handlers); }
  delete(path, ...handlers) { this.add('DELETE', path, ...handlers); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params !== null) return { handlers: route.handlers, params };
    }
    return null;
  }
}

function matchPath(pattern, pathname) {
  const patParts = pattern.split('/');
  const urlParts = pathname.split('/');
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

let _jwksCache = null;
let _jwksCacheTime = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

// ============================================================
// Auth — Clerk JWT via Web Crypto (no npm needed)
// ============================================================
async function verifyClerkToken(token, secretKey) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');

  const payload = JSON.parse(
    atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
  );
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  // Fetch Clerk JWKS to verify signature — cached for 1 hour so this
  // doesn't hit Clerk on every single authenticated request.
  const now = Date.now();
  if (!_jwksCache || (now - _jwksCacheTime) > JWKS_TTL_MS) {
    const res = await fetch('https://api.clerk.com/v1/jwks', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    _jwksCache = await res.json();
    _jwksCacheTime = now;
  }
  const jwks = _jwksCache;

  const header = JSON.parse(
    atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))
  );
  const jwk = jwks.keys?.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('JWK key not found');

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const enc  = new TextEncoder();
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const sig  = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!valid) throw new Error('Invalid signature');

  return {
    id:    payload.sub,
    email: payload.email ?? payload.primary_email_address ?? '',
    name:  payload.first_name
      ? `${payload.first_name} ${payload.last_name ?? ''}`.trim()
      : '',
  };
}

// ============================================================
// Request Handler
// ============================================================
const router = new Router();

// Health
router.get('/health', async (req, env) => {
  return json({ status: 'ok', timestamp: new Date().toISOString() }, 200, getOrigin(req));
});

// ── Admin ─────────────────────────────────────────────────────

async function requireAdmin(clerkUser, db) {
  const u = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(clerkUser.id).first();
  return u?.is_admin === 1;
}

router.get('/admin/users', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const users = await env.DB.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM user_assets WHERE user_id = u.id) as asset_count,
      (SELECT COUNT(*) FROM alert_history WHERE user_id = u.id) as alert_count,
      (SELECT verified FROM user_telegram WHERE user_id = u.id) as telegram_verified
    FROM users u ORDER BY u.created_at DESC
  `).all();
  return json(users.results ?? [], 200, origin);
});

router.post('/admin/expire/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  await env.DB.prepare(
    'UPDATE users SET active = 0, expires_at = ? WHERE id = ?'
  ).bind(Date.now(), params.id).run();
  return json({ success: true }, 200, origin);
});

// ── API key management ───────────────────────────────────────

router.get('/admin/api-keys', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { results } = await env.DB.prepare(`
    SELECT ak.id, ak.source, ak.label, ak.enabled, ak.added_at,
           COALESCE(aks.exhausted, 0) as exhausted,
           COALESCE(aks.calls_today, 0) as calls_today,
           '***' || substr(ak.key_value, -4) as key_preview
    FROM api_keys ak
    LEFT JOIN api_key_state aks ON ak.id = aks.key_name
    ORDER BY ak.source, ak.label ASC
  `).all();

  const DAILY_LIMIT = 800;
  const resetsAtUtc = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() + 1
  )).toISOString();

  const enriched = (results ?? []).map(k => ({
    ...k,
    daily_limit:   DAILY_LIMIT,
    credits_pct:   Math.round((k.calls_today / DAILY_LIMIT) * 100),
    resets_at_utc: resetsAtUtc,
  }));

  return json(enriched, 200, origin);
});

router.post('/admin/api-keys', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { source, key_value, label } = await req.json();
  if (!source || !key_value || !label) return json({ error: 'source, key_value, label required' }, 400, origin);
  const id  = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, source, key_value, label, enabled, added_at, added_by) VALUES (?,?,?,?,1,?,?)`
  ).bind(id, source, key_value, label, now, clerkUser.id).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO api_key_state (key_name, exhausted, calls_today, reset_at) VALUES (?,0,0,0)`
  ).bind(id).run();
  return json({ ok: true, id }, 201, origin);
});

router.patch('/admin/api-keys/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { enabled } = await req.json();
  await env.DB.prepare(`UPDATE api_keys SET enabled=? WHERE id=?`).bind(enabled ? 1 : 0, params.id).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/admin/api-keys/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  await env.DB.prepare(`DELETE FROM api_keys WHERE id=?`).bind(params.id).run();
  await env.DB.prepare(`DELETE FROM api_key_state WHERE key_name=?`).bind(params.id).run();
  return json({ ok: true }, 200, origin);
});

// ── Per-user asset limit ──────────────────────────────────────

router.patch('/admin/users/:id/asset-limit', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { asset_limit } = await req.json();
  if (!asset_limit || asset_limit < 1 || asset_limit > 50) {
    return json({ error: 'asset_limit must be between 1 and 50' }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET asset_limit=? WHERE id=?`).bind(asset_limit, params.id).run();
  return json({ ok: true, asset_limit }, 200, origin);
});

router.get('/admin/users/:id/assets', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const assets = await env.DB.prepare(
    'SELECT symbol, asset_type, added_at FROM user_assets WHERE user_id = ? ORDER BY added_at ASC'
  ).bind(params.id).all();
  return json(assets.results ?? [], 200, origin);
});

const ALL_TF_ACCESS = ['M5', 'M15', 'M30', '1H', '4H', 'D', 'W'];

router.get('/admin/users/:id/tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const row = await env.DB.prepare('SELECT user_tf_access FROM users WHERE id=?').bind(params.id).first();
  if (!row) return json({ error: 'User not found' }, 404, origin);
  const tfAccess = JSON.parse(row.user_tf_access || JSON.stringify(ALL_TF_ACCESS));
  return json({ user_id: params.id, tf_access: tfAccess }, 200, origin);
});

router.patch('/admin/users/:id/tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { tf_access } = await req.json();
  if (!Array.isArray(tf_access) || tf_access.some(tf => !ALL_TF_ACCESS.includes(tf))) {
    return json({ error: `tf_access must be an array containing only: ${ALL_TF_ACCESS.join(', ')}` }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET user_tf_access=? WHERE id=?`).bind(JSON.stringify(tf_access), params.id).run();
  return json({ ok: true }, 200, origin);
});

// ALL_NSE_TF_ACCESS — SYNC NOTICE: this array is duplicated in nse-worker/src/nse-cron.js
// as NSE_VALID_TFS. Both must be kept identical. No shared import is possible
// across Cloudflare Workers. If you change one, change the other in the same commit.
const ALL_NSE_TF_ACCESS = ['M1', 'M5', 'M15', 'M30', '1H', 'D'];

router.get('/admin/users/:id/nse-tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const row = await env.DB.prepare('SELECT nse_tf_access FROM users WHERE id=?').bind(params.id).first();
  if (!row) return json({ error: 'User not found' }, 404, origin);
  const nseTfAccess = JSON.parse(row.nse_tf_access || JSON.stringify(ALL_NSE_TF_ACCESS));
  return json({ user_id: params.id, nse_tf_access: nseTfAccess }, 200, origin);
});

router.patch('/admin/users/:id/nse-tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { nse_tf_access } = await req.json();
  if (!Array.isArray(nse_tf_access) || nse_tf_access.some(tf => !ALL_NSE_TF_ACCESS.includes(tf))) {
    return json({ error: `nse_tf_access must be an array containing only: ${ALL_NSE_TF_ACCESS.join(', ')}` }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET nse_tf_access=? WHERE id=?`).bind(JSON.stringify(nse_tf_access), params.id).run();
  return json({ ok: true }, 200, origin);
});

// ============================================================
// Main fetch handler
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const origin   = getOrigin(request);
    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method   = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Match route
    const match = router.match(method, pathname);
    if (!match) {
      return json({ error: 'Not found', path: pathname }, 404, origin);
    }

    // Auth — attempt token verification, attach result to request context
    let clerkUser = null;
    let authError = null;
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try {
        clerkUser = await verifyClerkToken(
          authHeader.replace('Bearer ', ''),
          env.CLERK_SECRET_KEY
        );
      } catch (e) {
        authError = e.message;
      }
    }

    // Attach context to request object
    request._ctx = {
      user:   clerkUser,
      error:  authError,
      origin,
      params: match.params,
    };

    try {
      return await match.handlers[0](request, env, ctx);
    } catch (err) {
      console.error('Handler error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500, origin);
    }
  },
};
