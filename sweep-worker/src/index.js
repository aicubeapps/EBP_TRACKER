// ============================================================
// Sweep Detector Worker — Entry Point
//
// Scheduling via cron-job.org HTTP triggers (POST /cron/sweep)
// instead of Cloudflare cron triggers (free tier limit workaround).
//
// Routes:
//   GET  /health          — public health check
//   POST /cron/sweep      — HTTP cron trigger (secured by X-Cron-Secret)
//
// IM-3 — /sweep/dashboard and /sweep/history moved to EBP Worker. This
// worker is now cron-only; any other path returns 404.
// ============================================================

import { handleSweepCron } from './sweep-cron.js';

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
    const validTFs = ['M15', 'M30', '1H', '4H'];

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

  return json({ error: 'Not found', worker: 'sweep-detector' }, 404, origin);
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