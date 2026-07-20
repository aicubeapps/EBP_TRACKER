import { Hono } from 'hono'

const admin = new Hono()

admin.get('/users', (c) => c.json({ message: 'not implemented', route: '/admin/users' }))
admin.get('/payments', (c) => c.json({ message: 'not implemented', route: '/admin/payments' }))
admin.post('/payments/:id/approve', (c) => c.json({ message: 'not implemented', route: `/admin/payments/${c.req.param('id')}/approve` }))
admin.post('/payments/:id/reject', (c) => c.json({ message: 'not implemented', route: `/admin/payments/${c.req.param('id')}/reject` }))
admin.get('/tokens', (c) => c.json({ message: 'not implemented', route: '/admin/tokens' }))
admin.post('/tokens', (c) => c.json({ message: 'not implemented', route: '/admin/tokens' }))

export default admin
