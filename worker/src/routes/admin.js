import { Hono } from 'hono';
import { adminAuth } from '../auth.js';

const admin = new Hono();

admin.use('*', adminAuth);

admin.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, name, plan, asset_limit, active, expires_at, created_at FROM users ORDER BY created_at DESC'
  ).all();
  return c.json(results);
});

admin.patch('/users/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const allowed = ['plan', 'asset_limit', 'active', 'expires_at', 'is_admin'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in body) { sets.push(`${k}=?`); vals.push(body[k]); }
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  vals.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  return c.json({ ok: true });
});

admin.get('/payments', async (c) => {
  const status = c.req.query('status') || 'pending';
  const { results } = await c.env.DB.prepare(
    'SELECT pl.*, u.email, u.name FROM payment_log pl JOIN users u ON pl.user_id=u.id WHERE pl.status=? ORDER BY pl.submitted_at DESC'
  ).bind(status).all();
  return c.json(results);
});

admin.post('/payments/:id/approve', async (c) => {
  const adminId = c.get('userId');
  const { id }  = c.req.param();
  const row = await c.env.DB.prepare('SELECT * FROM payment_log WHERE id=?').bind(id).first();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const tierMap = { free: { plan: 'free', days: 0, limit: 3 }, coffee: { plan: 'coffee', days: 30, limit: 5 }, beer: { plan: 'beer', days: 30, limit: 15 }, wine: { plan: 'wine', days: 30, limit: 30 } };
  const t = tierMap[row.tier] || tierMap.free;
  const expiresAt = t.days ? Date.now() + t.days * 86400000 : Date.now() + 365 * 86400000;

  await c.env.DB.prepare(
    'UPDATE payment_log SET status=?, approved_at=?, approved_by=? WHERE id=?'
  ).bind('approved', Date.now(), adminId, id).run();
  await c.env.DB.prepare(
    'UPDATE users SET plan=?, asset_limit=?, expires_at=? WHERE id=?'
  ).bind(t.plan, t.limit, expiresAt, row.user_id).run();

  return c.json({ ok: true });
});

admin.post('/payments/:id/reject', async (c) => {
  const { id } = c.req.param();
  await c.env.DB.prepare(
    'UPDATE payment_log SET status=? WHERE id=?'
  ).bind('rejected', id).run();
  return c.json({ ok: true });
});

admin.get('/tokens', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM invite_tokens ORDER BY created_at DESC'
  ).all();
  return c.json(results);
});

admin.post('/tokens', async (c) => {
  const token = crypto.randomUUID().split('-')[0].toUpperCase();
  await c.env.DB.prepare(
    'INSERT INTO invite_tokens (token, created_at) VALUES (?,?)'
  ).bind(token, Date.now()).run();
  return c.json({ token }, 201);
});

admin.delete('/tokens/:token', async (c) => {
  const { token } = c.req.param();
  await c.env.DB.prepare('UPDATE invite_tokens SET active=0 WHERE token=?').bind(token).run();
  return c.json({ ok: true });
});

export default admin;
