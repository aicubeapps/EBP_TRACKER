// ============================================================
// Sweep Detector Worker — Entry Point
//
// Scheduling via cron-job.org HTTP triggers (POST /cron/sweep)
// instead of Cloudflare cron triggers (free tier limit workaround).
//
// Routes:
//   GET  /health          — public health check
//   POST /cron/sweep      — HTTP cron trigger (secured by X-Cron-Secret)
//   GET  /sweep/dashboard — authenticated, sweep status per asset
//   GET  /sweep/history   — authenticated, recent sweep alerts
// ============================================================

import { handleSweepCron, detectSweep } from './sweep-cron.js';

// ── CORS ─────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://ebp-tracker.pages.dev',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Cron-Secret',
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

// ── Clerk JWT verification (Web Crypto, zero dependencies) ────

async function verifyClerkToken(token, secretKey) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');

  const payload = JSON.parse(
    atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
  );
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const jwks = await jwksRes.json();

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
  };
}

// ── Main fetch handler ────────────────────────────────────────

async function handleFetch(request, env) {
  const origin   = request.headers.get('Origin') ?? '';
  const url      = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ── Health check — public ────────────────────────────────────
  if (pathname === '/health') {
    return json({
      status: 'ok',
      worker: 'sweep-detector',
      timestamp: new Date().toISOString(),
    }, 200, origin);
  }
  
  // ── HTTP cron trigger — secured by X-Cron-Secret ────────────
  // Called by cron-job.org on schedule
  if (pathname === '/cron/sweep' && request.method === 'POST') {
    const secret = request.headers.get('X-Cron-Secret');
    if (!secret || secret !== env.CRON_SECRET) {
      return json({ error: 'Forbidden' }, 403, origin);
    }

    let body = {};
    try { body = await request.json(); } catch {}

    const tf       = body.tf ?? 'M15';
    const validTFs = ['M5', 'M15', 'M30', '1H', '4H'];

    if (!validTFs.includes(tf)) {
      return json({ error: `Invalid TF: ${tf}. Must be one of ${validTFs.join(', ')}` }, 400, origin);
    }

    try {
      const debugLog = [];
      await handleSweepCron(tf, env, debugLog);
      return json({
        ok: true,
        tf,
        fired_at: new Date().toISOString(),
        debug: debugLog,
      }, 200, origin);
    } catch (err) {
      console.error(`Cron trigger error TF=${tf}:`, err.message);
      return json({ error: err.message, stack: err.stack }, 500, origin);
    }
  }

  // ── Authenticated routes ─────────────────────────────────────

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }

  let clerkUser;
  try {
    clerkUser = await verifyClerkToken(
      authHeader.replace('Bearer ', ''),
      env.CLERK_SECRET_KEY
    );
  } catch (e) {
    return json({ error: 'Invalid token', detail: e.message }, 401, origin);
  }

  // GET /sweep/dashboard — sweep status per asset per TF
  if (pathname === '/sweep/dashboard' && request.method === 'GET') {
    const assets = await env.DB.prepare(`
      SELECT ua.id as asset_id, ua.symbol
      FROM user_assets ua
      WHERE ua.user_id = ?
    `).bind(clerkUser.id).all();

    const result = [];

    for (const asset of (assets.results ?? [])) {
      const { results: configs } = await env.DB.prepare(
        'SELECT timeframe FROM user_sweep_configs WHERE asset_id = ? AND enabled = 1'
      ).bind(asset.asset_id).all();
      const tfs    = (configs ?? []).map(c => c.timeframe);
      const status = {};

      for (const tf of tfs) {
        const cache = await env.DB.prepare(
          'SELECT * FROM sweep_candle_cache WHERE symbol = ? AND timeframe = ?'
        ).bind(asset.symbol, tf).first();

        if (cache) {
          const candles = [
            {
              open:  cache.bar_0_open,  high: cache.bar_0_high,
              low:   cache.bar_0_low,   close: cache.bar_0_close,
              time:  cache.bar_0_time,
            },
            {
              open:  cache.bar_1_open,  high: cache.bar_1_high,
              low:   cache.bar_1_low,   close: cache.bar_1_close,
              time:  cache.bar_1_time,
            },
          ];
          const sweep  = detectSweep(candles);
          status[tf]   = sweep ? sweep.direction : 'none';
        } else {
          status[tf] = 'none';
        }
      }

      result.push({ symbol: asset.symbol, sweepStatus: status });
    }

    return json(result, 200, origin);
  }

  // GET /sweep/history — recent sweep alerts
  if (pathname === '/sweep/history' && request.method === 'GET') {
    const limit  = parseInt(url.searchParams.get('limit') ?? '50');
    const alerts = await env.DB.prepare(`
      SELECT * FROM alert_history
      WHERE user_id = ? AND alert_type = 'sweep'
      ORDER BY fired_at DESC LIMIT ?
    `).bind(clerkUser.id, limit).all();

    return json(alerts.results ?? [], 200, origin);
  }

  return json({ error: 'Not found', path: pathname }, 404, origin);
}

// ── Export ────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error('Unhandled fetch error:', err.message);
      return new Response(
        JSON.stringify({ error: 'Internal server error', detail: err.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },

  // Cloudflare scheduled handler — not used (cron-job.org handles scheduling)
  async scheduled(event, env, ctx) {
    console.log('Scheduled event received — scheduling handled via cron-job.org HTTP triggers');
  },
};