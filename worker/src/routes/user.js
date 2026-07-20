import { Hono } from 'hono'

const user = new Hono()

user.get('/me', (c) => c.json({ message: 'not implemented', route: '/user/me' }))
user.get('/me/assets', (c) => c.json({ message: 'not implemented', route: '/user/me/assets' }))
user.post('/me/assets', (c) => c.json({ message: 'not implemented', route: '/user/me/assets' }))
user.delete('/me/assets/:symbol', (c) => c.json({ message: 'not implemented', route: `/user/me/assets/${c.req.param('symbol')}` }))

export default user
