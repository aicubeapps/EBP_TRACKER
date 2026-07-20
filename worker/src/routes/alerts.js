import { Hono } from 'hono';
import { clerkAuth } from '../auth.js';

const alerts = new Hono();

alerts.use('*', clerkAuth);

alerts.get('/history', async (c) => {
  const userId  = c.get('userId');
  const limit   = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const offset  = parseInt(c.req.query('offset') || '0');
  const symbol  = c.req.query('symbol');
  const tf      = c.req.query('tf');

  let sql   = 'SELECT * FROM alert_history WHERE user_id=?';
  const vals = [userId];
  if (symbol) { sql += ' AND symbol=?'; vals.push(symbol); }
  if (tf)     { sql += ' AND timeframe=?'; vals.push(tf); }
  sql += ' ORDER BY fired_at DESC LIMIT ? OFFSET ?';
  vals.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json(results);
});

export default alerts;
