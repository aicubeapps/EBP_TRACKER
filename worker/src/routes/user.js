import { Hono } from 'hono';
import { clerkAuth } from '../auth.js';
import { validateSymbol } from '../../../packages/core/datafeed.js';

const user = new Hono();

user.use('*', clerkAuth);

user.get('/me', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT id, email, name, plan, asset_limit, expires_at, active FROM users WHERE id=?'
  ).bind(userId).first();
  if (!row) return c.json({ error: 'User not found' }, 404);
  return c.json(row);
});

user.get('/me/assets', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM user_assets WHERE user_id=? AND active=1 ORDER BY added_at ASC'
  ).bind(userId).all();
  return c.json(results);
});

user.post('/me/assets', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { symbol, display_name, asset_type, timeframes, ebp_alert_mode } = body;

  if (!symbol || !asset_type) return c.json({ error: 'symbol and asset_type required' }, 400);

  const userRow = await c.env.DB.prepare(
    'SELECT plan, asset_limit FROM users WHERE id=?'
  ).bind(userId).first();
  if (!userRow) return c.json({ error: 'User not found' }, 404);

  const { count } = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM user_assets WHERE user_id=? AND active=1'
  ).bind(userId).first();
  if (count >= userRow.asset_limit) {
    return c.json({ error: `Asset limit reached (${userRow.asset_limit})` }, 403);
  }

  const validation = await validateSymbol(symbol.toUpperCase(), c.env.TWELVE_DATA_KEY);
  if (!validation.valid) return c.json({ error: 'Symbol not found on any data source' }, 422);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(`
    INSERT INTO user_assets (id, user_id, symbol, display_name, asset_type, timeframes, ebp_alert_mode, added_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(
    id, userId,
    symbol.toUpperCase(),
    display_name || symbol.toUpperCase(),
    asset_type,
    timeframes || 'W,D,4H,1H,M15',
    ebp_alert_mode || 'aligned',
    Date.now()
  ).run();

  return c.json({ id, symbol: symbol.toUpperCase() }, 201);
});

user.patch('/me/assets/:id', async (c) => {
  const userId = c.get('userId');
  const assetId = c.req.param('id');
  const body = await c.req.json();
  const allowed = ['timeframes', 'ebp_alert_mode', 'sweep_enabled', 'sweep_timeframes',
                   'sweep_alert_mode', 'combined_enabled', 'combined_pairs', 'combined_window_mins'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in body) { sets.push(`${k}=?`); vals.push(body[k]); }
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  vals.push(userId, assetId);
  await c.env.DB.prepare(
    `UPDATE user_assets SET ${sets.join(',')} WHERE user_id=? AND id=?`
  ).bind(...vals).run();
  return c.json({ ok: true });
});

user.delete('/me/assets/:id', async (c) => {
  const userId = c.get('userId');
  const assetId = c.req.param('id');
  await c.env.DB.prepare(
    'UPDATE user_assets SET active=0 WHERE user_id=? AND id=?'
  ).bind(userId, assetId).run();
  return c.json({ ok: true });
});

export default user;
