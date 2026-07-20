// Clerk JWT verification middleware
export async function clerkAuth(c, next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  // Stub: verify JWT with Clerk JWKS
  // const token = authHeader.slice(7)
  // const payload = await verifyClerkJWT(token, c.env.CLERK_SECRET_KEY)
  c.set('userId', 'stub_user_id')
  await next()
}

export async function adminAuth(c, next) {
  await clerkAuth(c, async () => {})
  const userId = c.get('userId')
  if (userId !== c.env?.ADMIN_USER_ID) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}
