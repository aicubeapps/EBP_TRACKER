import { createClerkClient } from '@clerk/backend';

export async function clerkAuth(c, next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
    const payload = await clerk.verifyToken(token);
    c.set('userId', payload.sub);
    await next();
  } catch (err) {
    console.warn('Auth failed:', err.message);
    return c.json({ error: 'Unauthorized' }, 401);
  }
}

export async function adminAuth(c, next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
    const payload = await clerk.verifyToken(token);
    const userId = payload.sub;
    const user = await c.env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(userId).first();
    if (!user?.is_admin) return c.json({ error: 'Forbidden' }, 403);
    c.set('userId', userId);
    await next();
  } catch (err) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
}
