// ============================================================
// NSE Worker — Entry Point
//
// Scheduling via cron-job.org HTTP triggers (POST /cron/nse), same
// pattern as the EBP and Sweep Workers.
//
// Routes:
//   GET    /health                                — public health check
//   POST   /cron/nse                               — HTTP cron trigger (secured by X-Cron-Secret)
//   GET    /nse/status                             — public
//   GET    /nse/search                             — Clerk JWT
//   GET    /user/nse-indicator-configs/:assetId     — Clerk JWT
//   POST   /user/nse-indicator-configs/:assetId     — Clerk JWT
//   PATCH  /user/nse-indicator-configs/:id          — Clerk JWT
//   DELETE /user/nse-indicator-configs/:id          — Clerk JWT
// ============================================================

import { handleNseCron } from './nse-cron.js';

// ── CORS (copied from worker/src/ebp-worker.js) ─────────────────

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

let _jwksCache = null;
let _jwksCacheTime = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Auth — Clerk JWT via Web Crypto (no npm needed), copied verbatim
// from worker/src/ebp-worker.js ─────────────────────────────────
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

// Shared by every Clerk-gated route below — attempts token verification,
// returns { clerkUser, error } same shape ebp-worker.js's req._ctx exposes.
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { clerkUser: null, error: 'Unauthorized' };
  }
  try {
    const clerkUser = await verifyClerkToken(authHeader.replace('Bearer ', ''), env.CLERK_SECRET_KEY);
    return { clerkUser, error: null };
  } catch (e) {
    return { clerkUser: null, error: e.message };
  }
}

// ── NSE search — proxies Upstox (equities) + Yahoo Finance (indices)
// symbol search server-side. Yahoo's endpoint sends no
// Access-Control-Allow-Origin header, so the frontend can't call it
// directly from the browser; this route exists purely to route around
// that CORS gap. ─────────────────────────────────────────────────
const NSE_KNOWN_INDICES = ['^NSEI', '^NSEBANK', '^BSESN', '^NIFTYBANK'];

async function handleNseSearch(req, env, origin) {
  const url = new URL(req.url);
  const q   = (url.searchParams.get('q') ?? '').trim();
  if (!q) return json([], 200, origin);

  // Run both sources in parallel — Upstox covers equities, Yahoo covers
  // indices only (Upstox's EQ-segment search doesn't surface index
  // instruments like ^NSEI at all). Promise.allSettled so one source
  // failing never kills the other.
  const [upstoxResults, yahooIndexResults] = await Promise.allSettled([

    // Source 1 — Upstox: equities only
    (async () => {
      const upstoxKey = await env.DB.prepare(
        "SELECT key_value FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
      ).first();
      if (!upstoxKey?.key_value) return [];

      const res = await fetch(
        `https://api.upstox.com/v2/instruments/search?query=${encodeURIComponent(q)}&exchanges=NSE&segments=EQ&records=20`,
        {
          headers: {
            'Authorization': `Bearer ${upstoxKey.key_value}`,
            'Accept': 'application/json'
          }
        }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data ?? [])
        .filter(i =>
          i.exchange === 'NSE' &&
          i.instrument_type === 'EQ' &&
          i.trading_symbol &&
          !i.trading_symbol.includes('-') // exclude derivatives
        )
        .map(i => ({
          symbol: `${i.trading_symbol}.NS`,
          shortName: i.name || i.trading_symbol,
          source: 'upstox'
        }));
    })(),

    // Source 2 — Yahoo: indices only
    (async () => {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=en-IN&region=IN`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.quotes ?? [])
        .filter(item => NSE_KNOWN_INDICES.includes(item.symbol))
        .map(item => ({
          symbol: item.symbol,
          shortName: item.shortName || item.longName || item.symbol,
          source: 'yahoo'
        }));
    })()

  ]);

  const equities = upstoxResults.status === 'fulfilled' ? upstoxResults.value : [];
  const indices  = yahooIndexResults.status === 'fulfilled' ? yahooIndexResults.value : [];

  // Equities first, indices after; dedupe by symbol in case of overlap.
  const seen = new Set();
  const combined = [...equities, ...indices].filter(r => {
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });

  return json(combined, 200, origin);
}

// ── NSE Indicator Configs (TDI / SMA Cloud) — CRUD handlers ────────

async function handleGetNseIndicatorConfigs(req, env, origin, assetId, clerkUser) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM nse_indicator_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC'
  ).bind(assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
}

async function handlePostNseIndicatorConfigs(req, env, origin, assetId, clerkUser) {
  const { indicator, timeframe, confirmation_mode, day_filter, bias_mode, htf_timeframe } = await req.json();

  if (indicator !== 'tdi' && indicator !== 'sma') {
    return json({ error: "indicator must be 'tdi' or 'sma'" }, 400, origin);
  }

  const validTfs = indicator === 'tdi' ? ['M15', 'M30'] : ['M15', 'M5', 'M30'];
  if (!validTfs.includes(timeframe)) {
    return json({ error: `timeframe must be one of: ${validTfs.join(', ')}` }, 400, origin);
  }

  if (indicator === 'sma' && bias_mode !== undefined && !['ttrades', 'htf_sma', 'none'].includes(bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades', 'htf_sma', or 'none'" }, 400, origin);
  }
  if (indicator === 'sma' && htf_timeframe !== undefined && !['1H', 'D'].includes(htf_timeframe)) {
    return json({ error: "htf_timeframe must be '1H' or 'D'" }, 400, origin);
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM nse_indicator_configs WHERE user_id=? AND asset_id=? AND indicator=? AND timeframe=?'
  ).bind(clerkUser.id, assetId, indicator, timeframe).first();
  if (existing) {
    return json({ error: 'Config already exists for this indicator/timeframe on this asset.' }, 400, origin);
  }

  const finalConfirmationMode = indicator === 'sma' ? (['mss', 'cisd', 'either'].includes(confirmation_mode) ? confirmation_mode : 'either') : null;
  const finalDayFilter    = indicator === 'sma' ? (day_filter === 0 ? 0 : 1) : null;
  const finalBiasMode     = indicator === 'sma' ? (['htf_sma', 'none'].includes(bias_mode) ? bias_mode : 'ttrades') : null;
  const finalHtfTimeframe = indicator === 'sma' ? (htf_timeframe === 'D' ? 'D' : '1H') : null;

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO nse_indicator_configs (id, user_id, asset_id, indicator, timeframe, confirmation_mode, day_filter, enabled, created_at, bias_mode, htf_timeframe)
    VALUES (?,?,?,?,?,?,?,1,?,?,?)
  `).bind(id, clerkUser.id, assetId, indicator, timeframe, finalConfirmationMode, finalDayFilter, Date.now(), finalBiasMode, finalHtfTimeframe).run();

  return json({
    id, indicator, timeframe, confirmation_mode: finalConfirmationMode, day_filter: finalDayFilter,
    bias_mode: finalBiasMode, htf_timeframe: finalHtfTimeframe, enabled: 1,
  }, 201, origin);
}

async function handlePatchNseIndicatorConfig(req, env, origin, id, clerkUser) {
  const body = await req.json();

  if (body.bias_mode !== undefined && !['ttrades', 'htf_sma', 'none'].includes(body.bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades', 'htf_sma', or 'none'" }, 400, origin);
  }
  if (body.htf_timeframe !== undefined && !['1H', 'D'].includes(body.htf_timeframe)) {
    return json({ error: "htf_timeframe must be '1H' or 'D'" }, 400, origin);
  }
  if (body.confirmation_mode !== undefined && !['mss', 'cisd', 'either'].includes(body.confirmation_mode)) {
    return json({ error: "confirmation_mode must be 'mss', 'cisd', or 'either'" }, 400, origin);
  }

  const sets = []; const vals = [];
  if (body.enabled !== undefined)       { sets.push('enabled = ?');       vals.push(body.enabled ? 1 : 0); }
  if (body.confirmation_mode !== undefined) { sets.push('confirmation_mode = ?'); vals.push(body.confirmation_mode); }
  if (body.day_filter !== undefined)    { sets.push('day_filter = ?');    vals.push(body.day_filter ? 1 : 0); }
  if (body.bias_mode !== undefined)     { sets.push('bias_mode = ?');     vals.push(body.bias_mode); }
  if (body.htf_timeframe !== undefined) { sets.push('htf_timeframe = ?'); vals.push(body.htf_timeframe); }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, id);
  await env.DB.prepare(`UPDATE nse_indicator_configs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
}

async function handleDeleteNseIndicatorConfig(req, env, origin, id, clerkUser) {
  const config = await env.DB.prepare(
    'SELECT * FROM nse_indicator_configs WHERE id = ? AND user_id = ?'
  ).bind(id, clerkUser.id).first();

  await env.DB.prepare('DELETE FROM nse_indicator_configs WHERE id = ? AND user_id = ?').bind(id, clerkUser.id).run();

  if (config) {
    if (config.indicator === 'tdi') {
      // nse_indicator_chain is per-user (has user_id) — safe to delete unconditionally.
      await env.DB.prepare(
        'DELETE FROM nse_indicator_chain WHERE user_id = ? AND asset_id = ? AND timeframe = ?'
      ).bind(clerkUser.id, config.asset_id, config.timeframe).run();
    } else if (config.indicator === 'sma') {
      // nse_sma_state has no user_id — it's shared symbol+TF-level state. Only
      // clear it once no other user still has an active SMA config on this
      // same symbol+TF, otherwise this would wipe their phase tracking too.
      const asset = await env.DB.prepare('SELECT symbol FROM user_assets WHERE id = ?').bind(config.asset_id).first();
      if (asset?.symbol) {
        const stillUsed = await env.DB.prepare(`
          SELECT COUNT(*) as cnt FROM nse_indicator_configs ic
          JOIN user_assets ua ON ic.asset_id = ua.id
          WHERE ua.symbol = ? AND ic.timeframe = ? AND ic.indicator = 'sma'
        `).bind(asset.symbol, config.timeframe).first();
        if ((stillUsed?.cnt ?? 0) === 0) {
          await env.DB.prepare(
            'DELETE FROM nse_sma_state WHERE symbol = ? AND timeframe = ?'
          ).bind(asset.symbol, config.timeframe).run();
        }
      }
    }
  }

  return json({ ok: true }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const origin = getOrigin(request);

    // CORS preflight — only the newly-added browser-facing NSE routes need
    // this; /health and /cron/nse below are server-to-server only and keep
    // their existing plain-Response behaviour unchanged.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && path === '/health') {
      return new Response(JSON.stringify({
        worker: 'nse-tracker',
        status: 'ok',
        timestamp: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST' && path === '/cron/nse') {
      const secret = request.headers.get('X-Cron-Secret');
      if (secret !== env.CRON_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }

      let body = {};
      try { body = await request.json(); } catch {}
      // Query-param fallback — lets the endpoint be tested manually without
      // wrestling with a POST body, and is resilient if a cron trigger's
      // configured body isn't actually reaching this Worker for any reason.
      const tf = body?.tf ?? url.searchParams.get('tf');
      if (!tf) {
        return new Response(JSON.stringify({ error: 'tf required' }), { status: 400 });
      }

      try {
        const result = await handleNseCron(env, tf);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error(`NSE cron trigger error TF=${tf}:`, err.message);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /nse/status — public, no auth required. Dashboard uses this to
    // show the "~15 min delayed" badge for non-admin users, who can't call
    // GET /admin/api-keys directly (on admin-worker).
    if (request.method === 'GET' && path === '/nse/status') {
      const key = await env.DB.prepare(
        "SELECT id FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
      ).first();
      return json({ upstox_configured: !!key }, 200, origin);
    }

    if (request.method === 'GET' && path === '/nse/search') {
      const { clerkUser, error } = await authenticate(request, env);
      if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
      return handleNseSearch(request, env, origin);
    }

    const configMatch = path.match(/^\/user\/nse-indicator-configs\/([^/]+)$/);
    if (configMatch) {
      const id = decodeURIComponent(configMatch[1]);
      const { clerkUser, error } = await authenticate(request, env);
      if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

      if (request.method === 'GET')    return handleGetNseIndicatorConfigs(request, env, origin, id, clerkUser);
      if (request.method === 'POST')   return handlePostNseIndicatorConfigs(request, env, origin, id, clerkUser);
      if (request.method === 'PATCH')  return handlePatchNseIndicatorConfig(request, env, origin, id, clerkUser);
      if (request.method === 'DELETE') return handleDeleteNseIndicatorConfig(request, env, origin, id, clerkUser);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
