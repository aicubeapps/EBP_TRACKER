// ============================================================
// NSE Worker — Entry Point
//
// Scheduling via cron-job.org HTTP triggers (POST /cron/nse), same
// pattern as the EBP and Sweep Workers.
//
// Routes:
//   GET  /health     — public health check
//   POST /cron/nse   — HTTP cron trigger (secured by X-Cron-Secret)
// ============================================================

import { handleNseCron } from './nse-cron.js';

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

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
      const tf = body.tf;
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

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
