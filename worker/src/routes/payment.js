import { Hono } from 'hono';
import { clerkAuth } from '../auth.js';

const payment = new Hono();

payment.use('*', clerkAuth);

const TIER_PRICES = { coffee: 99, beer: 299, wine: 999 };

payment.post('/submit', async (c) => {
  const userId = c.get('userId');
  const { tier, upi_ref } = await c.req.json();

  if (!TIER_PRICES[tier]) return c.json({ error: 'Invalid tier' }, 400);
  if (!upi_ref?.trim()) return c.json({ error: 'UPI reference required' }, 400);

  const existing = await c.env.DB.prepare(
    'SELECT id FROM payment_log WHERE user_id=? AND status=? LIMIT 1'
  ).bind(userId, 'pending').first();
  if (existing) return c.json({ error: 'A pending payment already exists' }, 409);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(`
    INSERT INTO payment_log (id, user_id, tier, amount_inr, upi_ref, status, submitted_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(id, userId, tier, TIER_PRICES[tier], upi_ref.trim(), 'pending', Date.now()).run();

  return c.json({ id, status: 'pending' }, 201);
});

payment.get('/status', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT id, tier, status, submitted_at, approved_at FROM payment_log WHERE user_id=? ORDER BY submitted_at DESC LIMIT 1'
  ).bind(userId).first();
  return c.json(row || { status: 'none' });
});

export default payment;
